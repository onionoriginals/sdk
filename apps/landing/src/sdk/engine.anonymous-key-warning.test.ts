/**
 * Issue #598 — "Publication can discard control keys; landing demo keeps
 * authoring keys only in memory."
 *
 * The remaining, narrow defect (per the issue's current-state triage) is that
 * an anonymous visitor's authoring key lives only in that browser tab's
 * memory, and nothing said so before a durable publication was made with it.
 * These pin that the engine now says so, at the moment it mints that key,
 * rather than staying silent until a later reload fails closed.
 */
import { describe, test, expect } from 'bun:test';
import { DemoEngine, type DemoEvent } from './engine';
import { generateArtwork } from './artwork';

const ART = generateArtwork('Ephemeral Key', 'Artwork', 1).svg;

function collect(engine: DemoEngine): DemoEvent[] {
  const events: DemoEvent[] = [];
  engine.on((e) => events.push(e));
  return events;
}

describe('anonymous authoring key disclosure (#598)', () => {
  test('minting an anonymous key emits an explicit, non-recoverable-after-reload warning', async () => {
    const engine = new DemoEngine();
    const events = collect(engine);

    const state = await engine.create('Ephemeral Key', 'Artwork', ART);

    const warned = events.find((e) => e.type === 'authorship:ephemeral');
    expect(warned).toBeDefined();
    expect(warned!.summary).toMatch(/browser tab/i);
    expect(warned!.summary).toMatch(/reload/i);
    const payload = warned!.payload as { verificationMethodId: string };
    // Same controller that actually signed the genesis event.
    const proof = state.celLog[0].proof[0];
    expect(payload.verificationMethodId).toBe(proof.verificationMethod!.split('#')[0]);
  });

  test('the warning fires once, not on every signed append', async () => {
    const engine = new DemoEngine();
    const events = collect(engine);

    await engine.create('Ephemeral Key', 'Artwork', ART);
    await engine.update('Still Ephemeral', 'Artwork', ART);

    expect(events.filter((e) => e.type === 'authorship:ephemeral').length).toBe(1);
  });
});
