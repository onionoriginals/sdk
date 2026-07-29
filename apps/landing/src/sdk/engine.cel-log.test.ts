import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { createWebvhHostStore } from '../../server/webvh-host';

// publish() does real hosting over HTTP, which has no origin under `bun test`.
// Route it through an in-process store, same approach as the publish→resolve
// roundtrip test.
function installHostFetch(host: string) {
  const store = createWebvhHostStore();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(raw, `http://${host}`);
    if (url.pathname.startsWith('/api/host/')) {
      return store.handlePut(
        new Request(url, {
          method,
          headers: init?.headers as HeadersInit,
          body: init?.body as BodyInit
        }),
        url
      );
    }
    return store.serve(new Request(url), url) ?? new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

/**
 * The demo replaced the SDK's emitter-event stream with the asset's actual
 * Cryptographic Event Log. These assert the panel is showing the real signed
 * chain — not a re-rendering of app-level notifications — so the claim the page
 * makes about verifiable provenance stays true.
 */
describe('CEL exposed to the demo', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installHostFetch('demo.test');
  });
  afterEach(() => restore());

  test('create yields a genesis entry: signed, and with no parent', async () => {
    const engine = new DemoEngine();
    await engine.create('Chain Test', 'Artwork', SVG);
    const { celLog } = engine.snapshot();

    expect(celLog.length).toBe(1);
    expect(celLog[0].type).toBe('create');
    // Genesis is the only entry that may omit previousEvent.
    expect(celLog[0].previousEvent).toBeUndefined();
    expect(celLog[0].proof[0]?.proofValue).toBeTruthy();
  });

  test('publishing appends a migrate entry that links to the genesis', async () => {
    const engine = new DemoEngine();
    await engine.create('Chain Test', 'Artwork', SVG);
    await engine.publish();
    const { celLog } = engine.snapshot();

    expect(celLog.length).toBeGreaterThanOrEqual(2);
    const migrate = celLog[1];
    expect(migrate.type).toBe('migrate');
    // The link is the whole point: every non-genesis entry commits to its parent.
    expect(typeof migrate.previousEvent).toBe('string');
    expect(migrate.previousEvent!.length).toBeGreaterThan(0);
    expect(migrate.proof[0]?.proofValue).toBeTruthy();
  });

  test('every entry after the first carries a previousEvent digest', async () => {
    const engine = new DemoEngine();
    await engine.create('Chain Test', 'Artwork', SVG);
    await engine.publish();
    const { celLog } = engine.snapshot();

    for (const [i, entry] of celLog.entries()) {
      if (i === 0) continue;
      expect(entry.previousEvent).toBeTruthy();
    }
  });

  test('entries are plain data, so the panel cannot mutate the live log', async () => {
    const engine = new DemoEngine();
    await engine.create('Chain Test', 'Artwork', SVG);

    const first = engine.snapshot().celLog;
    first[0].type = 'tampered';

    // A fresh snapshot must be unaffected by edits to a previous one.
    expect(engine.snapshot().celLog[0].type).toBe('create');
  });
});
