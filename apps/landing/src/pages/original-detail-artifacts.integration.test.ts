/**
 * End-to-end guarantee for the detail page's data pipeline: after a real authed
 * publish (DemoEngine → DurableHostingStorageAdapter → originals store), every
 * artifact URL webvhArtifacts() derives from the DID — did.jsonl, cel.json, and
 * each sealed resource — serves from the durable store, and the parsed
 * artifacts fold into the timeline/summary/digests the page renders.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { DemoEngine } from '../sdk/engine';
import { createOriginalsStore } from '../../server/originals-store';
import { createOriginalsRoutes } from '../../server/originals-routes';
import { createWebvhHostStore } from '../../server/webvh-host';
import { buildFetch } from '../../server/app';
import {
  webvhArtifacts,
  celTimeline,
  celResources,
  parseDidLog,
  didLogSummary,
  digestMultibaseSha256Hex,
  sha256HexToResourceMultibase,
  type CelLog
} from './original-detail-data';

const JWT = 'test-secret-at-least-32-chars-long!!';
const HOST = 'demo.test';

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Route the browser's durable PUTs, the summary POST, AND the resolver's https
// GETs through one in-process server (buildFetch) with a real durable store.
function installServerFetch(store: ReturnType<typeof createOriginalsStore>) {
  const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
  const apiRoutes = { 'POST /api/originals': originals.record, 'GET /api/originals': originals.list } as Record<
    string,
    (req: Request, url: URL) => Response | Promise<Response>
  >;
  const fetchFn = buildFetch({ apiRoutes, hostStore: createWebvhHostStore(), distDir: '/nonexistent/', originals });
  const cookie = getAuthCookieConfig(signToken('sub-1', 's@b.com', undefined, { secret: JWT }));
  const cookieHeader = `${cookie.name}=${cookie.value}`;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = new URL(raw, `http://${HOST}`);
    const headers = new Headers(init?.headers as HeadersInit);
    headers.set('cookie', cookieHeader); // the browser would attach the auth cookie
    return fetchFn(new Request(url, { ...init, headers }));
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = real; };
}

describe('detail page artifacts after a real durable publish', () => {
  let restore: () => void;
  let store: ReturnType<typeof createOriginalsStore>;

  beforeEach(() => {
    (import.meta as unknown as { env: Record<string, string> }).env ??= {};
    (import.meta as unknown as { env: Record<string, string> }).env.VITE_WEBVH_HOST = HOST;
    store = createOriginalsStore({ dataDir: mkdtempSync(join(tmpdir(), 'od-artifacts-')) });
    restore = installServerFetch(store);
  });
  afterEach(() => restore());

  test('every derived artifact URL serves, and the artifacts fold into the page models', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    await engine.create('Detail Piece', 'Artwork', svg);
    const state = await engine.publish();
    const did = state.webvhDid!;

    const arts = webvhArtifacts(did);
    expect(arts).not.toBeNull();

    // did.jsonl serves at the derived URL and summarizes to THIS did.
    const logRes = store.serve(new URL(arts!.logUrl));
    expect(logRes).not.toBeNull();
    const entries = parseDidLog(await logRes!.text());
    const summary = didLogSummary(entries);
    expect(summary?.did).toBe(did);
    expect(summary?.scid).toBeDefined();
    expect(summary?.verificationMethods.length).toBeGreaterThan(0);

    // cel.json serves beside it and folds into the timeline the page renders.
    const celRes = store.serve(new URL(arts!.celUrl));
    expect(celRes).not.toBeNull();
    const cel = JSON.parse(await celRes!.text()) as CelLog;
    const steps = celTimeline(cel);
    expect(steps[0].state).toBe('done'); // create (did:cel genesis)
    expect(steps[1].state).toBe('done'); // publish (did:webvh)
    expect(steps[1].facts.find((f) => f.label === 'Published as')?.value).toBe(did);
    expect(steps[2].state).toBe('upcoming'); // inscribe (did:btco)
    expect(steps[0].proof?.proofValue).toBeDefined();

    // Every sealed resource serves at its derived URL (declared multihash
    // digest → hosted raw-hash multibase, the exact key publishResources
    // writes), and the artwork's declared digest matches the sha-256 of the
    // bytes actually served.
    const resources = celResources(cel);
    expect(resources.length).toBe(2); // artwork.svg + metadata.json
    const hostedSeg = (digest: string) => sha256HexToResourceMultibase(digestMultibaseSha256Hex(digest)!)!;
    for (const r of resources) {
      expect(r.digestMultibase).toBeDefined();
      const served = store.serve(new URL(arts!.resourceUrl(hostedSeg(r.digestMultibase!))));
      expect(served).not.toBeNull();
    }
    const artwork = resources.find((r) => r.mediaType === 'image/svg+xml')!;
    const artRes = store.serve(new URL(arts!.resourceUrl(hostedSeg(artwork.digestMultibase!))));
    const bytes = new Uint8Array(await artRes!.arrayBuffer());
    expect(toHex(sha256(bytes))).toBe(digestMultibaseSha256Hex(artwork.digestMultibase!));
  });
});
