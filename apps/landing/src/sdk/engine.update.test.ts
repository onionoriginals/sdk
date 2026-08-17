import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { createWebvhHostStore } from '../../server/webvh-host';
import { summarize } from '../components/CelChain';

// publish() does real hosting over HTTP, which has no origin under `bun test`.
function installHostFetch(host: string) {
  const store = createWebvhHostStore();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(raw, `http://${host}`);
    if (url.pathname.startsWith('/api/host/')) {
      return store.handlePut(
        new Request(url, { method, headers: init?.headers as HeadersInit, body: init?.body as BodyInit }),
        url
      );
    }
    return store.serve(new Request(url), url) ?? new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = real; };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
const SVG_V2 = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';
const SVG_V3 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Where the SDK hosts a resource version: {origin}/{path}/resources/{multibase}. */
function resourceUrl(webvhDid: string, hashHex: string): string {
  const parts = webvhDid.split(':');
  const domain = decodeURIComponent(parts[3]);
  const path = parts.slice(4).map(decodeURIComponent).join('/');
  const bytes = Uint8Array.from(hashHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const multibase =
    'u' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://${domain}/${path}/resources/${multibase}`;
}

/**
 * Revising an asset after creating it: a signed `update` event appended to the
 * asset's own event log. These assert the demo shows the REAL chain growing —
 * the whole claim the page makes — not just a swapped-out preview image.
 */
describe('revise a created asset', () => {
  let restore: () => void;
  beforeEach(() => { restore = installHostFetch('demo.test'); });
  afterEach(() => restore());

  test('appends a signed update event and advances the resource version', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('Revisable', 'Artwork', SVG);
    expect(created.resource.version).toBe(1);
    expect(created.celLog.map((e) => e.type)).toEqual(['create']);

    const updated = await engine.update(SVG_V2, 'second pass');

    expect(updated.resource.version).toBe(2);
    expect(updated.resource.content).toBe(SVG_V2);
    expect(updated.resource.hash).not.toBe(created.resource.hash);
    expect(updated.celLog.map((e) => e.type)).toEqual(['create', 'update']);

    // The update event is genuinely signed and chained, like every other entry.
    const event = updated.celLog[1];
    expect(event.proof[0]?.proofValue).toBeTruthy();
    expect(event.previousEvent).toBeTruthy();
    // Reference-shaped body: the signed toHash, never the bytes.
    expect(event.data.resourceId).toBe('artwork.svg');
    expect(event.data.toVersion).toBe(2);
    expect(event.data.previousVersionHash).toBe(created.resource.hash);
    expect(JSON.stringify(event.data)).not.toContain('<svg');
  });

  test('revisions stack — each one chains to the version before it', async () => {
    const engine = new DemoEngine();
    await engine.create('Revisable', 'Artwork', SVG);
    const v2 = await engine.update(SVG_V2);
    const v3 = await engine.update(SVG_V3);

    expect(v3.resource.version).toBe(3);
    expect(v3.celLog.map((e) => e.type)).toEqual(['create', 'update', 'update']);
    expect(v3.celLog[2].data.previousVersionHash).toBe(v2.resource.hash);
  });

  test('the asset still verifies after being revised', async () => {
    const engine = new DemoEngine();
    await engine.create('Revisable', 'Artwork', SVG);
    await engine.update(SVG_V2);
    // The whole signed chain — genesis plus the update — must still verify.
    expect(await engine.asset!.verify()).toBe(true);
  });

  test('the same bytes are refused rather than logged as a no-op version', async () => {
    const engine = new DemoEngine();
    await engine.create('Revisable', 'Artwork', SVG);
    await expect(engine.update(SVG)).rejects.toThrow(/unchanged/i);
  });

  test('a PUBLISHED asset is still revisable, and the new bytes are hosted', async () => {
    const engine = new DemoEngine();
    await engine.create('Revisable', 'Artwork', SVG);
    const published = await engine.publish();
    expect(published.layer).toBe('did:webvh');

    const updated = await engine.update(SVG_V2);

    expect(updated.resource.version).toBe(2);
    expect(updated.celLog.map((e) => e.type)).toEqual(['create', 'migrate', 'update']);
    // The bytes the update names are fetchable at the URL the DID implies —
    // a published log must never out-run what the origin serves.
    const res = await fetch(resourceUrl(updated.webvhDid!, updated.resource.hash));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SVG_V2);
  });

  test('a published revision leaves the previous version resolvable', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('Revisable', 'Artwork', SVG);
    const published = await engine.publish();
    await engine.update(SVG_V2);

    const old = await fetch(resourceUrl(published.webvhDid!, created.resource.hash));
    expect(old.status).toBe(200);
    expect(await old.text()).toBe(SVG);
  });

  test('an inscribed asset is refused — that append is paid on-chain', async () => {
    const engine = new DemoEngine();
    await engine.create('Revisable', 'Artwork', SVG);
    await engine.publish();
    await engine.inscribe();
    await expect(engine.update(SVG_V2)).rejects.toThrow(/on-chain/);
  });

  test('update before create is refused', async () => {
    const engine = new DemoEngine();
    await expect(engine.update(SVG_V2)).rejects.toThrow(/Create an asset first/);
  });

  // Regression: `resources` GROWS by append, so index-based reads pinned the
  // panel to genesis and showed v1's bytes and hash after every revision.
  test('the snapshot reports the newest version, not genesis', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('Revisable', 'Artwork', SVG);
    const updated = await engine.update(SVG_V2);

    expect(updated.resource.content).not.toBe(created.resource.content);
    // The metadata resource is untouched by an artwork revision.
    expect(updated.metadata?.id).toBe('metadata.json');
    expect(updated.metadata?.content).toBe(created.metadata?.content);
  });

  test('the chain panel glosses an update with its resource and version', async () => {
    const engine = new DemoEngine();
    await engine.create('Revisable', 'Artwork', SVG);
    const updated = await engine.update(SVG_V2);
    const gloss = summarize(updated.celLog[1]);
    expect(gloss).toContain('artwork.svg');
    expect(gloss).toContain('v2');
  });
});
