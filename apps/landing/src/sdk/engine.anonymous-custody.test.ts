/**
 * #598 — anonymous authoring custody after a reload.
 *
 * An anonymous creator's authoring key lives only in the `DemoEngine`
 * instance that generated it (`resolveAuthorshipSigner`'s in-memory
 * `authorshipSigner` field). The hosted CEL/WebVH history survives a reload
 * — a fresh engine can still resolve and read it — but a fresh engine has no
 * way to reconstruct the SAME key, so the CEL layer correctly refuses to
 * sign further changes as that controller (`CEL_AUTHORITY`). These pin that
 * refusal is explicit and actionable rather than a raw protocol error, and
 * that a signed-in creator's Turnkey-restored key does not share the defect.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { createWebvhHostStore } from '../../server/webvh-host';
import { installCel3Host, engineWithSigner } from './cel3-test-helpers';
import { demoFailureMessage } from '../components/demo-logic';

const SVG = (id: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"></svg>`;

// Same wiring as engine.publish-resolve.test.ts: route the browser adapter's
// PUT /api/host/* and the resolver's https GETs through one in-process host
// store, so an anonymous publish → reload → resolve round-trip needs no live
// HTTPS origin.
function installHostFetch(host: string) {
  const store = createWebvhHostStore();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(raw, `http://${host}`);
    if (url.pathname.startsWith('/api/host/')) {
      if (method === 'GET') return store.read(url);
      const req = new Request(url, {
        method,
        headers: init?.headers as HeadersInit,
        body: init?.body as BodyInit,
      });
      return method === 'GET' ? store.read(url) : store.handlePut(req, url);
    }
    const served = store.serve(new Request(url), url);
    if (served) return served;
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe('anonymous authoring custody after reload (#598)', () => {
  const host = 'demo.test';
  let restore: () => void;

  beforeEach(() => {
    (import.meta as unknown as { env: Record<string, string> }).env ??= {};
    (import.meta as unknown as { env: Record<string, string> }).env.VITE_WEBVH_HOST = host;
    restore = installHostFetch(host);
  });
  afterEach(() => restore());

  test('a fresh anonymous browser is told plainly why it cannot sign further edits', async () => {
    const engine = new DemoEngine();
    await engine.create('Mine', 'Artwork', SVG('v1'));
    const published = await engine.publish();

    const reloaded = new DemoEngine();
    await reloaded.hydrateFromWeb(published.webvhDid!);

    await expect(
      reloaded.update('New Title', 'Artwork', SVG('v2')),
    ).rejects.toThrow(/anonymous authoring keys live only in the tab/i);
    // The raw CEL protocol code must not leak past the friendlier message.
    await expect(
      reloaded.update('New Title', 'Artwork', SVG('v2')),
    ).rejects.not.toThrow(/CEL_AUTHORITY/);
  });

  test('the clear message actually reaches the visitor through the UI error path', async () => {
    // Demo.tsx never renders a raw thrown message — every catch routes
    // through demoFailureMessage(), which discards anything that isn't a
    // DemoCopyError (or a recognised hosting-adapter failure) in favor of
    // generic copy. A plain Error here would be silently replaced on screen.
    const engine = new DemoEngine();
    await engine.create('Mine', 'Artwork', SVG('v1'));
    const published = await engine.publish();

    const reloaded = new DemoEngine();
    await reloaded.hydrateFromWeb(published.webvhDid!);

    const err = await reloaded
      .update('New Title', 'Artwork', SVG('v2'))
      .catch((e: unknown) => e);
    expect(demoFailureMessage(err)).toMatch(
      /anonymous authoring keys live only in the tab/i,
    );
  });

  test('the same anonymous tab keeps full edit access without a reload', async () => {
    const engine = new DemoEngine();
    await engine.create('Mine', 'Artwork', SVG('v1'));
    await engine.publish();

    const state = await engine.update('New Title', 'Artwork', SVG('v2'));
    expect(state.provenance.name).toBe('New Title');
    expect(state.resource.version).toBe(2);
  });

  test('an anonymous reload can still read the hosted history, just not sign it', async () => {
    const engine = new DemoEngine();
    await engine.create('Mine', 'Artwork', SVG('v1'));
    const published = await engine.publish();

    const reloaded = new DemoEngine();
    const state = await reloaded.hydrateFromWeb(published.webvhDid!);
    expect(state.resource.content).toEqual(published.resource.content);
    expect(state.webvhResolved).toBe(true);
  });
});

describe('signed-in authoring custody after a fresh session (#598)', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());

  test('a Turnkey-restored key can keep editing after a fresh engine/session', async () => {
    host = installCel3Host('sub-1');
    // engineWithSigner injects the key directly, standing in for the same
    // Turnkey account deterministically re-deriving it in a fresh session —
    // unlike the anonymous case, this key is not regenerated on reload.
    const { engine, signer } = engineWithSigner('sub-1');
    await engine.create('Mine', 'Artwork', SVG('v1'));
    const published = await engine.publish();

    const fresh = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    Object.assign(fresh, { authorshipSigner: signer });
    await fresh.hydrateFromWeb(published.webvhDid!);

    const state = await fresh.update('New Title', 'Artwork', SVG('v2'));
    expect(state.provenance.name).toBe('New Title');
    expect(state.resource.version).toBe(2);
  });
});
