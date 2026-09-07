/**
 * Revising an Original with a custody-held controller key.
 *
 * The break these pin: supplying a `signer` to `createAsset` means the SDK
 * generates no key and puts NOTHING in the keyStore. `create`, `publish` and
 * `inscribe` were each given that signer; `update` was not, so its two
 * `addResourceVersion` appends fell through to a keyStore lookup that found
 * nothing and threw CEL_APPEND_FAILED (NO_SIGNING_KEY) — for every signed-in
 * user who edited a title, since edit-title (#489) is not auth-gated.
 *
 * These run the real SDK against a real Ed25519 key, so a signer that stops
 * being threaded fails here rather than in production.
 */
import { describe, test, expect } from 'bun:test';
import { createLocalSigner, type CelSigner } from '@originals/sdk';
import { DemoEngine } from './engine';
const SVG = (id: string) => `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"></svg>`;
function externalAuthorshipSigner(): CelSigner {
  return createLocalSigner('Ed25519', crypto.getRandomValues(new Uint8Array(32)));
}
function engineAuthoringWith(signer: CelSigner): DemoEngine {
  const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
  Object.assign(engine, { authorshipSigner: signer });
  return engine;
}

describe('revising an Original whose controller key is held outside the SDK', () => {
  test('the artwork gets a signed v2 instead of failing to append', async () => {
    const signer = externalAuthorshipSigner();
    const engine = engineAuthoringWith(signer);
    await engine.create('First Title', 'Artwork', SVG('v1'));

    // Before the fix this rejected with CEL_APPEND_FAILED (NO_SIGNING_KEY).
    const state = await engine.update('Second Title', 'Artwork', SVG('v2'));

    expect(state.resource.content).toBe(SVG('v2'));
    expect(state.resource.version).toBe(2);
  });

  test('the update event is signed by the SAME controller as genesis', async () => {
    const signer = externalAuthorshipSigner();
    const engine = engineAuthoringWith(signer);
    await engine.create('First Title', 'Artwork', SVG('v1'));
    await engine.update('Second Title', 'Artwork', SVG('v2'));

    const events = engine.asset!.celLog.log;
    expect(events.map((e) => e.event.operation.type)).toEqual(['create', 'update', 'update', 'update']);
    expect(engine.asset!.state.name).toBe('Second Title');
    for (const e of events) {
      const proof = Array.isArray(e.proof) ? e.proof[0] : e.proof;
      expect(proof.verificationMethod.split('#')[0]).toBe(signer.controller);
    }
  });

  test('the whole revised log verifies', async () => {
    const engine = engineAuthoringWith(externalAuthorshipSigner());
    await engine.create('First Title', 'Artwork', SVG('v1'));
    await engine.update('Second Title', 'Artwork', SVG('v2'));

    const asset = (engine as unknown as { asset: { verify(): Promise<unknown> } }).asset;
    const result = (await asset.verify()) as { verified?: boolean } | boolean;
    expect(typeof result === 'boolean' ? result : result.verified).toBe(true);
  });

  // The anonymous path must keep working: no signer supplied means the SDK
  // generates a controller into its in-memory keyStore, and the keyStore
  // fallback that the fix bypasses is exactly what signs these appends.
  test('an anonymous run still revises through the SDK keyStore', async () => {
    const engine = new DemoEngine();
    await engine.create('First Title', 'Artwork', SVG('v1'));
    const state = await engine.update('Second Title', 'Artwork', SVG('v2'));
    expect(state.resource.version).toBe(2);
  });
});
