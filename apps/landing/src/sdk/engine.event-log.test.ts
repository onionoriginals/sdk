/**
 * LANDING-005 — the live event log and the provenance/resource inspector.
 *
 * The demo's claim is that these panels render REAL SDK output, not a script.
 * Nothing asserted that: the headless smoke test only gates on the absence of
 * console errors, which a hardcoded event list would also satisfy. These tests
 * pin the two things the panels actually read — the DemoEvent stream and the
 * resource/provenance fields of DemoAssetState — to what the SDK emits.
 */
import { describe, test, expect } from 'bun:test';
import { DemoEngine, type DemoEvent } from './engine';
import { generateArtwork } from './artwork';

const ART = generateArtwork('Event Log', 'Artwork', 1).svg;

function collect(engine: DemoEngine): DemoEvent[] {
  const events: DemoEvent[] = [];
  engine.on((e) => events.push(e));
  return events;
}

describe('event log', () => {
  test('create emits real SDK events in the DemoEvent shape', async () => {
    const engine = new DemoEngine();
    const events = collect(engine);

    await engine.create('Event Log', 'Artwork', ART);

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(typeof e.type).toBe('string');
      expect(e.type.length).toBeGreaterThan(0);
      // `at` is what the log renders as a timestamp.
      expect(new Date(e.at).toISOString()).toBe(e.at);
      expect(typeof e.summary).toBe('string');
      expect(e.summary.trim().length).toBeGreaterThan(0);
      // The inspector renders `payload` — it must be the raw event, not a string.
      expect(e.payload).toBeDefined();
      expect(typeof e.payload).toBe('object');
    }
  });

  test("the genesis event is the SDK's own asset:created, carrying the real did", async () => {
    const engine = new DemoEngine();
    const events = collect(engine);

    const state = await engine.create('Event Log', 'Artwork', ART);

    const created = events.find((e) => e.type === 'asset:created');
    expect(created).toBeDefined();
    // The payload is the SDK event, so the id in it IS the asset's did:cel.
    const payload = created!.payload as { asset: { id: string } };
    expect(payload.asset.id).toBe(state.did);
    expect(payload.asset.id.startsWith('did:cel:')).toBe(true);
    expect(created!.summary).toContain('did:cel');
  });

  test('events accumulate in emission order and are not replayed to late subscribers', async () => {
    const engine = new DemoEngine();
    const early = collect(engine);

    await engine.create('Event Log', 'Artwork', ART);

    expect(early.length).toBeGreaterThan(0);
    const times = early.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    // A panel mounted after the fact sees only what happens next — the log is a
    // live stream, so the UI must keep its own history (it does).
    const late = collect(engine);
    expect(late).toEqual([]);
  });

  test('unsubscribing stops delivery', async () => {
    const engine = new DemoEngine();
    const events: DemoEvent[] = [];
    const off = engine.on((e) => events.push(e));
    off();

    await engine.create('Event Log', 'Artwork', ART);

    expect(events).toEqual([]);
  });
});

describe('resource + provenance inspector', () => {
  test('the resource panel reads the artwork bytes actually carried by the asset', async () => {
    const engine = new DemoEngine();
    const state = await engine.create('Event Log', 'Artwork', ART);

    expect(state.resource.content).toBe(ART);
    expect(state.resource.contentType).toContain('svg');
    expect(state.resource.id.length).toBeGreaterThan(0);
    // The displayed hash is a real sha-256 hex digest of those exact bytes.
    expect(state.resource.hash).toMatch(/^[0-9a-f]{64}$/);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ART))
    );
    expect([...digest].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(
      state.resource.hash
    );
  });

  test('the provenance panel gets the SDK provenance object, and the layer starts at did:cel', async () => {
    const engine = new DemoEngine();
    const state = await engine.create('Event Log', 'Artwork', ART);

    expect(state.layer).toBe('did:cel');
    expect(state.provenance).toBeDefined();
    expect(typeof state.provenance).toBe('object');
    // Ownership is the sat, so provenance carries no transfers before did:btco.
    const provenance = state.provenance as { createdAt?: string; migrations?: unknown[] };
    expect(typeof provenance.createdAt).toBe('string');
    expect(Array.isArray(provenance.migrations)).toBe(true);
    expect(provenance.migrations).toEqual([]);
  });

  test('metadata rides alongside the artwork as its own resource', async () => {
    const engine = new DemoEngine();
    const state = await engine.create('Event Log', 'Artwork', ART);

    expect(state.metadata).toBeDefined();
    expect(state.metadata!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => JSON.parse(state.metadata!.content)).not.toThrow();
  });
});
