/**
 * verifyOriginal against artifacts from a REAL publish (DemoEngine → durable
 * store), so the checks are exercised on the exact bytes the detail page fetches.
 *
 * The inscribed case is the regression: a btco-anchored log carries a
 * `bitcoin-ordinals-2024` witness proof that fails closed without an ordinals
 * lookup, which used to turn the CEL check red on every asset taken through the
 * demo's third step.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { DemoEngine } from './engine';
import { verifyOriginal } from './verify-original';
import { createOriginalsStore } from '../../server/originals-store';
import { createOriginalsRoutes } from '../../server/originals-routes';
import { createWebvhHostStore } from '../../server/webvh-host';
import { buildFetch } from '../../server/app';
import {
  webvhArtifacts,
  celResources,
  parseDidLog,
  digestMultibaseSha256Hex,
  sha256HexToResourceMultibase,
  type CelLog
} from '../pages/original-detail-data';

const JWT = 'test-secret-at-least-32-chars-long!!';
const HOST = 'demo.test';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';

function installServerFetch(store: ReturnType<typeof createOriginalsStore>) {
  const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
  const apiRoutes = {
    'POST /api/originals': originals.record,
    'GET /api/originals': originals.list
  } as Record<string, (req: Request, url: URL) => Response | Promise<Response>>;
  const fetchFn = buildFetch({ apiRoutes, hostStore: createWebvhHostStore(), distDir: '/nonexistent/', originals });
  const cookie = getAuthCookieConfig(signToken('sub-1', 's@b.com', undefined, { secret: JWT }));
  const cookieHeader = `${cookie.name}=${cookie.value}`;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), `http://${HOST}`);
    const headers = new Headers(init?.headers as HeadersInit);
    headers.set('cookie', cookieHeader); // the browser would attach the auth cookie
    return fetchFn(new Request(url, { ...init, headers }));
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = real; };
}

/** Fetch back exactly what the detail page fetches, then verify it. */
async function verifyPublished(store: ReturnType<typeof createOriginalsStore>, did: string) {
  const arts = webvhArtifacts(did)!;
  const logEntries = parseDidLog(await store.serve(new URL(arts.logUrl))!.text());
  const celLog = JSON.parse(await store.serve(new URL(arts.celUrl))!.text()) as CelLog;
  const artwork = celResources(celLog).find((r) => r.mediaType === 'image/svg+xml')!;
  const declaredHash = digestMultibaseSha256Hex(artwork.digestMultibase!)!;
  const served = store.serve(new URL(arts.resourceUrl(sha256HexToResourceMultibase(declaredHash)!)))!;
  const resourceBytes = new Uint8Array(await served.arrayBuffer());
  const checks = await verifyOriginal({ did, logEntries, celLog, resourceBytes, declaredHash });
  return { checks, celLog };
}

describe('verifyOriginal on a real published Original', () => {
  let restore: () => void;
  let store: ReturnType<typeof createOriginalsStore>;

  beforeEach(() => {
    (import.meta as unknown as { env: Record<string, string> }).env ??= {};
    (import.meta as unknown as { env: Record<string, string> }).env.VITE_WEBVH_HOST = HOST;
    store = createOriginalsStore({ dataDir: mkdtempSync(join(tmpdir(), 'verify-original-')) });
    restore = installServerFetch(store);
  });
  afterEach(() => restore());

  test('a published (not inscribed) asset passes all three checks', async () => {
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    await engine.create('Published Piece', 'Artwork', SVG);
    const { webvhDid } = await engine.publish();

    const { checks } = await verifyPublished(store, webvhDid!);
    expect(checks.map((c) => c.id)).toEqual(['hash', 'log', 'cel']);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.id === 'cel')!.detail).toContain('2 signed events verified');
  });

  test('an INSCRIBED asset still verifies, scoped to the events the browser can check', async () => {
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    await engine.create('Inscribed Piece', 'Artwork', SVG);
    const { webvhDid } = await engine.publish();
    await engine.inscribe();

    const { checks, celLog } = await verifyPublished(store, webvhDid!);
    // The inscribe step really did extend the log past the web publication.
    expect(celLog.events.length).toBeGreaterThan(2);
    expect(checks.every((c) => c.ok)).toBe(true);
    const cel = checks.find((c) => c.id === 'cel')!;
    expect(cel.detail).toContain(`2 of ${celLog.events.length} signed events verified`);
    expect(cel.detail).toContain('Bitcoin anchor');
  });

  test('a tampered genesis event fails the CEL check', async () => {
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    await engine.create('Tampered Piece', 'Artwork', SVG);
    const { webvhDid } = await engine.publish();

    const arts = webvhArtifacts(webvhDid!)!;
    const celLog = JSON.parse(await store.serve(new URL(arts.celUrl))!.text()) as CelLog;
    celLog.events[0].data!.name = 'not-what-was-signed';

    const checks = await verifyOriginal({
      did: webvhDid!,
      logEntries: parseDidLog(await store.serve(new URL(arts.logUrl))!.text()),
      celLog,
      resourceBytes: null,
      declaredHash: null
    });
    expect(checks.find((c) => c.id === 'cel')!.ok).toBe(false);
  });

  test('a CEL log whose migrate targets another DID fails the CEL check', async () => {
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    await engine.create('Mismatched Piece', 'Artwork', SVG);
    const { webvhDid } = await engine.publish();

    const arts = webvhArtifacts(webvhDid!)!;
    const celLog = JSON.parse(await store.serve(new URL(arts.celUrl))!.text()) as CelLog;

    const checks = await verifyOriginal({
      did: 'did:webvh:QmSomeoneElse:demo.test:other',
      logEntries: parseDidLog(await store.serve(new URL(arts.logUrl))!.text()),
      celLog,
      resourceBytes: null,
      declaredHash: null
    });
    const cel = checks.find((c) => c.id === 'cel')!;
    expect(cel.ok).toBe(false);
    expect(cel.detail).toBe('CEL log does not bind to this DID');
  });
});
