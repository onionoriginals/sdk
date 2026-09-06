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
import { ed25519 } from '@noble/curves/ed25519.js';
import { multikey, signerFromExternalSigner, type OriginalsSigner } from '@originals/sdk';
import { DemoEngine } from './engine';

const SVG = (id: string) => `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"></svg>`;

/**
 * An Ed25519 signer with the shape `resolveAuthorshipSigner` produces — the
 * SDK-owned-preimage `signBytes` seam, not a document-level `sign`. Standing in
 * for Turnkey: what matters is that the key lives OUTSIDE the SDK's keyStore,
 * which is the condition that broke the revise path.
 */
function externalAuthorshipSigner(): OriginalsSigner {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKeyMultibase = multikey.encodePublicKey(ed25519.getPublicKey(privateKey), 'Ed25519');
  return signerFromExternalSigner(
    {
      getVerificationMethodId: () => `did:key:${publicKeyMultibase}`,
      sign: async () => {
        throw new Error('signs SDK-owned preimages via signBytes');
      },
      signBytes: async (data: Uint8Array) => ({ signature: ed25519.sign(data, privateKey) }),
    },
    { publicKeyMultibase }
  );
}

/**
 * An engine already holding a resolved authorship signer. The real resolver
 * dynamic-imports the Turnkey browser client, which must not load under
 * `bun test` — so the cached result is seeded directly, which is exactly the
 * state a signed-in browser reaches after its first append.
 */
function engineAuthoringWith(signer: OriginalsSigner): DemoEngine {
  const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
  Object.assign(engine as unknown as Record<string, unknown>, {
    authorshipSigner: signer,
    authorshipResolved: true,
  });
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

    const events = (engine as unknown as {
      asset: { celLog?: { events?: Array<{ type: string; proof?: Array<{ verificationMethod?: string }> }> } };
    }).asset.celLog?.events;
    expect(events).toBeDefined();
    expect(events!.map((e) => e.type)).toEqual(['create', 'update', 'update']);
    // Genesis names this key as controller, and pre-anchor the CEL accepts
    // only its current controller — so every append must carry the same vm.
    for (const e of events!) {
      expect(e.proof?.[0]?.verificationMethod).toContain(signer.publicKeyMultibase);
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
