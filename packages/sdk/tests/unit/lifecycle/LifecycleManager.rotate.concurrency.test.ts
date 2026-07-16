/**
 * Phase-3 Task 4 carry-forward: rotateBtcoKeys concurrency guard.
 *
 * rotateBtcoKeys was check-then-act across awaits with no in-flight guard
 * (same class of bug as transferOwnership pre-#255): two overlapping
 * rotations of the same asset would both pass the did:btco binding check
 * and both broadcast a reinscription. Guard it the same way
 * (LifecycleManager.transfer.concurrency.test.ts is the sibling suite).
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { multikey } from '../../../src/crypto/Multikey';

describe('rotateBtcoKeys concurrency guard', () => {
  test('a second concurrent rotation of the same asset is rejected with OPERATION_IN_PROGRESS', async () => {
    class SlowProvider extends OrdMockProvider {
      inscribeCalls = 0;
      async createInscription(params: any): Promise<any> {
        this.inscribeCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return super.createInscription(params);
      }
    }
    const provider = new SlowProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    provider.inscribeCalls = 0;

    const newKey1 = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    const newKey2 = multikey.encodePublicKey(new Uint8Array(32).fill(8), 'Ed25519');

    const [first, second] = await Promise.allSettled([
      sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey1 }),
      sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey2 })
    ]);

    const outcomes = [first, second];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    // Exactly one rotation succeeds; the other is rejected by the guard
    // BEFORE broadcasting a second reinscription.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string; message: string };
    expect(reason.code ?? reason.message).toContain('OPERATION_IN_PROGRESS');
    expect(provider.inscribeCalls).toBe(1);
  });

  test('the guard is released after a rotation completes (sequential rotations work)', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const newKey1 = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    const newKey2 = multikey.encodePublicKey(new Uint8Array(32).fill(8), 'Ed25519');

    const rot1 = await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey1 });
    const rot2 = await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey2 });
    expect(typeof rot1.inscriptionId).toBe('string');
    expect(typeof rot2.inscriptionId).toBe('string');
  });

  test('the guard is released after a failed rotation (retry not blocked)', async () => {
    class FailOnceProvider extends OrdMockProvider {
      failNext = false;
      async createInscription(params: any): Promise<any> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('rotation broadcast failed');
        }
        return super.createInscription(params);
      }
    }
    const provider = new FailOnceProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    provider.failNext = true;
    await expect(
      sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey })
    ).rejects.toThrow('rotation broadcast failed');

    // Guard released: the retry reaches the provider instead of OPERATION_IN_PROGRESS.
    const rotation = await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });
    expect(typeof rotation.inscriptionId).toBe('string');
  });
});
