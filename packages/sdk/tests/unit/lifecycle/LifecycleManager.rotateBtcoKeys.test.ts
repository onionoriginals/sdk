import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { multikey } from '@originals/cel';
import { MockKeyStore } from '../../mocks/MockKeyStore';

/**
 * Under sat-gated appends, rotateKey is rejected after the btco anchor — and a
 * did:btco asset is definitionally past the anchor, so rotateBtcoKeys always
 * refuses (KEY_ROTATION_NOT_PERMITTED): the controller key lineage is frozen
 * at inscription time; a sat holder authors with their OWN key instead. The
 * method must refuse BEFORE mutating anything or spending anything.
 */
describe('rotateBtcoKeys (removed capability: lineage frozen at the anchor)', () => {
  class CountingProvider extends OrdMockProvider {
    inscriptions = 0;
    async createInscription(params: unknown): Promise<ReturnType<OrdMockProvider['createInscription']> extends Promise<infer T> ? T : never> {
      this.inscriptions += 1;
      return super.createInscription(params as never) as never;
    }
  }

  test('always throws KEY_ROTATION_NOT_PERMITTED, with the log untouched and nothing inscribed', async () => {
    const provider = new CountingProvider();
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const logBefore = asset.celLog!;
    const inscriptionsBefore = provider.inscriptions;

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    let err: unknown;
    try {
      await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe('KEY_ROTATION_NOT_PERMITTED');
    expect((err as Error).message).toMatch(/holding the sat grants the right to append, not control of the key set/);

    // Nothing mutated, nothing paid.
    expect(asset.celLog).toBe(logBefore);
    expect(asset.celLog!.events.some(e => e.type === 'rotateKey')).toBe(false);
    expect(provider.inscriptions).toBe(inscriptionsBefore);
  });

  test('the asset still verifies after the refused rotation', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '9a'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await expect(sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey })).rejects.toThrow(/not permitted after the btco anchor/);
    expect(await asset.verify({ ordinalsProvider: provider })).toBe(true);
  });
});
