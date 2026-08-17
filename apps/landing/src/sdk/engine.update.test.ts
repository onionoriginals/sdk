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

  test('revising is refused once the asset is published', async () => {
    const engine = new DemoEngine();
    await engine.create('Revisable', 'Artwork', SVG);
    await engine.publish();
    await expect(engine.update(SVG_V2)).rejects.toThrow(/did:cel/);
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
