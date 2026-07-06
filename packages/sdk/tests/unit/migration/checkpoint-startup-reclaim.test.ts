/**
 * #323 review — "Cleanup sweep is unreachable".
 *
 * The checkpoint self-healing sweep (cleanupOldCheckpoints → retryPendingDeletions
 * + storage-truth enumeration sweep) previously only ran if an application called
 * it by hand: normal SDK operation used only the per-migration one-shot
 * deleteCheckpoint() 24h timer. On restart the in-memory timer and any
 * pending-deletion marker are gone, so a checkpoint stranded by a delete whose
 * tombstone AND marker writes both failed could never be reclaimed automatically.
 *
 * migrate() now runs cleanupOldCheckpoints() once per process, lazily on the
 * first real migration, re-arming the sweep as part of normal operation.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import { CheckpointManager } from '../../../src/migration/checkpoint/CheckpointManager';
import type { OriginalsConfig } from '../../../src/types';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
  storageAdapter: new MemoryStorageAdapter()
};

function res(id: string, hash: string) {
  return [{ id, type: 'Image', contentType: 'image/png', hash, content: `data-${id}` }];
}

afterEach(() => {
  MigrationManager.resetInstance();
});

describe('MigrationManager reclaims stranded checkpoints automatically (#323 review)', () => {
  it('runs cleanupOldCheckpoints once, lazily on the first real migration', async () => {
    MigrationManager.resetInstance();
    const sweepSpy = spyOn(CheckpointManager.prototype, 'cleanupOldCheckpoints');
    try {
      const sdk = OriginalsSDK.create({ ...baseConfig, storageAdapter: new MemoryStorageAdapter() });
      const manager = MigrationManager.getInstance(
        (sdk as unknown as { config: OriginalsConfig }).config,
        sdk.did,
        sdk.credentials
      );

      // A read-only cost estimate must NOT trigger the self-healing sweep.
      const est = await sdk.did.createDIDPeer(res('re', 'e0'));
      await manager.migrate({
        sourceDid: est.id,
        targetLayer: 'webvh',
        domain: 'example.com',
        estimateCostOnly: true
      });
      expect(sweepSpy).toHaveBeenCalledTimes(0);

      // First real migration reclaims checkpoints stranded by a prior process.
      const peer1 = await sdk.did.createDIDPeer(res('r1', 'a1'));
      const r1 = await manager.migrate({
        sourceDid: peer1.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });
      expect(r1.success).toBe(true);
      expect(sweepSpy).toHaveBeenCalledTimes(1);

      // Subsequent migrations do not re-run the once-per-process startup reclaim.
      const peer2 = await sdk.did.createDIDPeer(res('r2', 'b2'));
      const r2 = await manager.migrate({
        sourceDid: peer2.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });
      expect(r2.success).toBe(true);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
    } finally {
      sweepSpy.mockRestore();
    }
  });
});
