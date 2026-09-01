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

/** Where the SDK hosts a resource version: {origin}/{path}/resources/{multibase}
 *  — the CANONICAL multihash segment ("uEi…"), the only form written. */
function resourceUrl(webvhDid: string, hashHex: string): string {
  const parts = webvhDid.split(':');
  const domain = decodeURIComponent(parts[3]);
  const path = parts.slice(4).map(decodeURIComponent).join('/');
  const bytes = Uint8Array.from([0x12, 0x20, ...hashHex.match(/../g)!.map((h) => parseInt(h, 16))]);
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

  test('a title edit revises BOTH the artwork and the metadata that describes it', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('First Title', 'Artwork', SVG);
    expect(created.resource.version).toBe(1);
    expect(created.celLog.map((e) => e.type)).toEqual(['create']);

    const updated = await engine.update('Second Title', 'Artwork', SVG_V2);

    expect(updated.resource.version).toBe(2);
    expect(updated.resource.content).toBe(SVG_V2);
    // metadata.json embeds the title AND the artwork hash, so it follows —
    // leaving it behind would have the asset describe bytes it no longer holds.
    expect(updated.celLog.map((e) => e.type)).toEqual(['create', 'update', 'update']);
    const meta = JSON.parse(updated.metadata!.content) as {
      title: string;
      created: string;
      artwork: { sha256: string };
    };
    expect(meta.title).toBe('Second Title');
    expect(meta.artwork.sha256).toBe(updated.resource.hash);
    // Genesis `created` is when the asset was made, not when it was last edited.
    expect(meta.created).toBe(
      (JSON.parse(created.metadata!.content) as { created: string }).created
    );
  });

  test('the update event is signed, chained and reference-shaped', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('First Title', 'Artwork', SVG);
    const updated = await engine.update('Second Title', 'Artwork', SVG_V2);

    const event = updated.celLog[1];
    expect(event.type).toBe('update');
    expect(event.proof[0]?.proofValue).toBeTruthy();
    expect(event.previousEvent).toBeTruthy();
    expect(event.data.resourceId).toBe('artwork.svg');
    expect(event.data.toVersion).toBe(2);
    expect(event.data.previousVersionHash).toBe(created.resource.hash);
    // The signed body carries the toHash, never the bytes.
    expect(JSON.stringify(event.data)).not.toContain('<svg');
  });

  test('re-committing identical text and artwork logs nothing', async () => {
    const engine = new DemoEngine();
    await engine.create('Same', 'Artwork', SVG);
    const again = await engine.update('Same', 'Artwork', SVG);
    // No no-op versions: addResourceVersion would refuse them, so update skips.
    expect(again.celLog.map((e) => e.type)).toEqual(['create']);
    expect(again.resource.version).toBe(1);
  });

  test('editing only the style still revises the metadata', async () => {
    const engine = new DemoEngine();
    await engine.create('Same', 'Artwork', SVG);
    const updated = await engine.update('Same', 'Dot Grid', SVG);

    // Artwork bytes unchanged here (the caller passed the same SVG), so only
    // metadata.json gains a version.
    expect(updated.resource.version).toBe(1);
    expect(updated.celLog.map((e) => e.type)).toEqual(['create', 'update']);
    expect((JSON.parse(updated.metadata!.content) as { style: string }).style).toBe('Dot Grid');
  });

  test('revisions stack — each one chains to the version before it', async () => {
    const engine = new DemoEngine();
    await engine.create('One', 'Artwork', SVG);
    const v2 = await engine.update('Two', 'Artwork', SVG_V2);
    const v3 = await engine.update('Three', 'Artwork', SVG_V3);

    expect(v3.resource.version).toBe(3);
    const updates = v3.celLog.filter((e) => e.type === 'update' && e.data.resourceId === 'artwork.svg');
    expect(updates).toHaveLength(2);
    expect(updates[1].data.previousVersionHash).toBe(v2.resource.hash);
  });

  test('the asset still verifies after being revised', async () => {
    const engine = new DemoEngine();
    await engine.create('One', 'Artwork', SVG);
    await engine.update('Two', 'Artwork', SVG_V2);
    expect(await engine.asset!.verify()).toBe(true);
  });

  test('a PUBLISHED asset is still revisable, and the new bytes are hosted', async () => {
    const engine = new DemoEngine();
    await engine.create('One', 'Artwork', SVG);
    const published = await engine.publish();
    expect(published.layer).toBe('did:webvh');

    const updated = await engine.update('Two', 'Artwork', SVG_V2);

    expect(updated.resource.version).toBe(2);
    // The bytes the update names are fetchable at the URL the DID implies —
    // a published log must never out-run what the origin serves.
    const res = await fetch(resourceUrl(updated.webvhDid!, updated.resource.hash));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SVG_V2);
  });

  test('a published revision leaves the previous version resolvable', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('One', 'Artwork', SVG);
    const published = await engine.publish();
    await engine.update('Two', 'Artwork', SVG_V2);

    const old = await fetch(resourceUrl(published.webvhDid!, created.resource.hash));
    expect(old.status).toBe(200);
    expect(await old.text()).toBe(SVG);
  });

  test('an inscribed asset is refused — that append is paid on-chain', async () => {
    const engine = new DemoEngine();
    await engine.create('One', 'Artwork', SVG);
    await engine.publish();
    await engine.inscribe();
    await expect(engine.update('Two', 'Artwork', SVG_V2)).rejects.toThrow(/on-chain/);
  });

  test('update before create is refused', async () => {
    const engine = new DemoEngine();
    await expect(engine.update('Two', 'Artwork', SVG_V2)).rejects.toThrow(/Create an asset first/);
  });

  // Regression: `resources` GROWS by append, so index-based reads pinned the
  // panel to genesis and showed v1's bytes and hash after every revision.
  test('the snapshot reports the newest version of each resource', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('One', 'Artwork', SVG);
    const updated = await engine.update('Two', 'Artwork', SVG_V2);

    expect(updated.resource.content).not.toBe(created.resource.content);
    expect(updated.metadata?.id).toBe('metadata.json');
    expect(updated.metadata?.content).not.toBe(created.metadata?.content);
  });

  test('the chain panel glosses an update with its resource and version', async () => {
    const engine = new DemoEngine();
    await engine.create('One', 'Artwork', SVG);
    const updated = await engine.update('Two', 'Artwork', SVG_V2);
    const gloss = summarize(updated.celLog[1]);
    expect(gloss).toContain('artwork.svg');
    expect(gloss).toContain('v2');
  });
});
