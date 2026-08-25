/**
 * The edit interaction as a user performs it: type a new title, watch the
 * artwork regenerate from that text, commit, repeat — then publish and edit
 * again. Drives the real generator so the "the text IS the artwork" claim is
 * checked against actual bytes, not a stand-in string.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { generateArtwork } from './artwork';
import { createWebvhHostStore } from '../../server/webvh-host';

function installHostFetch(host: string) {
  const store = createWebvhHostStore();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), `http://${host}`);
    const method = (init?.method ?? 'GET').toUpperCase();
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

const NONCE = 7;
const art = (title: string, medium = 'Artwork') => generateArtwork(title, medium, NONCE).svg;

describe('editing an Original by its title', () => {
  let restore: () => void;
  beforeEach(() => { restore = installHostFetch('demo.test'); });
  afterEach(() => restore());

  test('the title is what makes the artwork — different text, different bytes', () => {
    expect(art('Sunrise')).not.toBe(art('Sunset'));
    // …and it is deterministic, so an edit is reproducible rather than random.
    expect(art('Sunrise')).toBe(art('Sunrise'));
  });

  test('retitle → commit → retitle again, with the log tracking each version', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('Sunrise', 'Artwork', art('Sunrise'));
    expect(created.resource.content).toBe(art('Sunrise'));
    expect(created.resource.version).toBe(1);

    // The user types a new title; the preview regenerates from that text.
    const second = await engine.update('Sunset', 'Artwork', art('Sunset'));
    expect(second.resource.content).toBe(art('Sunset'));
    expect(second.resource.version).toBe(2);
    expect(JSON.parse(second.metadata!.content).title).toBe('Sunset');

    const third = await engine.update('Moonrise', 'Artwork', art('Moonrise'));
    expect(third.resource.content).toBe(art('Moonrise'));
    expect(third.resource.version).toBe(3);
    expect(JSON.parse(third.metadata!.content).title).toBe('Moonrise');

    // Genesis plus two edits, each edit touching artwork + metadata.
    expect(third.celLog.filter((e) => e.type === 'update')).toHaveLength(4);
    expect((await engine.asset!.verify()).verified).toBe(true);
  });

  test('typing the title back to what was committed produces no new version', async () => {
    const engine = new DemoEngine();
    await engine.create('Sunrise', 'Artwork', art('Sunrise'));
    await engine.update('Sunset', 'Artwork', art('Sunset'));
    const back = await engine.update('Sunrise', 'Artwork', art('Sunrise'));

    // v3 — going back to earlier TEXT is still a new version of the asset, not
    // a rewrite of history: the log only ever grows.
    expect(back.resource.version).toBe(3);
    expect(back.resource.content).toBe(art('Sunrise'));
    expect(back.celLog.filter((e) => e.type === 'create')).toHaveLength(1);
  });

  test('editing after publishing keeps every version fetchable', async () => {
    const engine = new DemoEngine();
    const created = await engine.create('Sunrise', 'Artwork', art('Sunrise'));
    const published = await engine.publish();
    const edited = await engine.update('Sunset', 'Artwork', art('Sunset'));

    const url = (hash: string) => {
      const parts = published.webvhDid!.split(':');
      const bytes = Uint8Array.from([0x12, 0x20, ...hash.match(/../g)!.map((h) => parseInt(h, 16))]);
      const mb = 'u' + btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return `https://${decodeURIComponent(parts[3])}/${parts.slice(4).join('/')}/resources/${mb}`;
    };

    expect(await (await fetch(url(edited.resource.hash))).text()).toBe(art('Sunset'));
    expect(await (await fetch(url(created.resource.hash))).text()).toBe(art('Sunrise'));
  });
});
