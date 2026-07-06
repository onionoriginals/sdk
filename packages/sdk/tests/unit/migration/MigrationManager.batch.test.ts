/**
 * MigrationManager.migrateBatch — per-item option merging and fail-fast behavior.
 *
 * Item 1 (blocker): `{ sourceDid: did, targetLayer, ...options }` spread the
 * caller's options AFTER the per-item fields. Because BatchMigrationOptions
 * extends MigrationOptions (where sourceDid is REQUIRED), any type-correct
 * options object clobbered every item's sourceDid/targetLayer — migrating one
 * asset N times and never touching the rest.
 *
 * Item 4: fail-fast (continueOnError: false/unset) never actually stopped,
 * because migrate() converts operational failures into returned
 * MigrationResult{success:false} instead of rejecting.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import type { MigrationOptions, MigrationResult } from '../../../src/migration/types';
import { MigrationStateEnum } from '../../../src/migration/types';
import type { OriginalsConfig } from '../../../src/types';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
  storageAdapter: new MemoryStorageAdapter()
};

function makeManager() {
  MigrationManager.resetInstance();
  const sdk = OriginalsSDK.create({ ...baseConfig });
  const manager = MigrationManager.getInstance(
    (sdk as unknown as { config: OriginalsConfig }).config,
    sdk.did,
    sdk.credentials
  );
  return { sdk, manager };
}

async function makePeerDid(sdk: OriginalsSDK, id: string) {
  return sdk.did.createDIDPeer([
    { id, type: 'Image', contentType: 'image/png', hash: 'abc123', content: `data-${id}` }
  ]);
}

afterEach(() => {
  MigrationManager.resetInstance();
});

describe('migrateBatch per-item options are not clobbered by the shared options object (item 1)', () => {
  it('migrates each of 3 distinct DIDs exactly once even when options carries a sourceDid', async () => {
    const { manager } = makeManager();

    // Spy on migrate() to observe exactly which sourceDids are attempted.
    const migratedDids: string[] = [];
    (manager as unknown as { migrate: (o: MigrationOptions) => Promise<MigrationResult> }).migrate =
      async (options: MigrationOptions): Promise<MigrationResult> => {
        migratedDids.push(options.sourceDid);
        return {
          migrationId: `mig_${options.sourceDid}`,
          success: true,
          sourceDid: options.sourceDid,
          targetDid: `did:webvh:example.com:${options.sourceDid.slice(-4)}`,
          sourceLayer: 'peer',
          targetLayer: options.targetLayer,
          state: MigrationStateEnum.COMPLETED,
          duration: 1,
          cost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }
        };
      };

    const dids = ['did:peer:z6MkAlpha', 'did:peer:z6MkBravo', 'did:peer:z6MkCharlie'];

    // A type-correct BatchMigrationOptions object necessarily carries a
    // sourceDid (it is required on MigrationOptions). It must NOT override
    // the per-item sourceDid/targetLayer.
    const result = await manager.migrateBatch(dids, 'webvh', {
      sourceDid: dids[0],
      targetLayer: 'webvh',
      domain: 'example.com',
      continueOnError: true
    });

    expect(migratedDids.sort()).toEqual([...dids].sort());
    // Each DID migrated exactly once
    for (const did of dids) {
      expect(migratedDids.filter(d => d === did).length).toBe(1);
    }
    expect(result.total).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    // Each result entry belongs to its own DID
    for (const did of dids) {
      expect(result.results.get(did)?.sourceDid).toBe(did);
    }
  });

  it('end-to-end: 3 real peer DIDs all reach webvh with distinct targets', async () => {
    const { sdk, manager } = makeManager();
    const didA = await makePeerDid(sdk, 'res-a');
    const didB = await makePeerDid(sdk, 'res-b');
    const didC = await makePeerDid(sdk, 'res-c');
    const dids = [didA.id, didB.id, didC.id];

    const result = await manager.migrateBatch(dids, 'webvh', {
      sourceDid: dids[0],
      targetLayer: 'webvh',
      domain: 'example.com',
      continueOnError: true
    });

    expect(result.total).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    const targetDids = dids.map(d => result.results.get(d)?.targetDid);
    for (const [i, did] of dids.entries()) {
      const r = result.results.get(did);
      expect(r?.success).toBe(true);
      expect(r?.sourceDid).toBe(did);
      expect(targetDids[i]).toBeDefined();
    }
    // 3 distinct migrations → 3 distinct target DIDs
    expect(new Set(targetDids).size).toBe(3);
  });
});

describe('migrateBatch fail-fast stops on a returned unsuccessful result (item 4)', () => {
  it('continueOnError=false: an operational failure (returned success:false) halts the batch', async () => {
    const { manager } = makeManager();

    const attempted: string[] = [];
    (manager as unknown as { migrate: (o: MigrationOptions) => Promise<MigrationResult> }).migrate =
      async (options: MigrationOptions): Promise<MigrationResult> => {
        attempted.push(options.sourceDid);
        // Every migration fails OPERATIONALLY (returned result, no throw) —
        // exactly what migrate() does via handleMigrationFailure.
        return {
          migrationId: `mig_${attempted.length}`,
          success: false,
          sourceDid: options.sourceDid,
          sourceLayer: 'peer',
          targetLayer: options.targetLayer,
          state: MigrationStateEnum.FAILED,
          duration: 1,
          cost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
          error: {
            type: 'validation_error' as never,
            code: 'VALIDATION_FAILED',
            message: 'boom',
            sourceDid: options.sourceDid,
            timestamp: Date.now()
          }
        };
      };

    const dids = ['did:peer:z6MkOne', 'did:peer:z6MkTwo', 'did:peer:z6MkThree'];
    const result = await manager.migrateBatch(dids, 'webvh', {
      sourceDid: dids[0],
      targetLayer: 'webvh',
      continueOnError: false
    });

    // Fail-fast must actually stop: only the first DID is attempted.
    expect(attempted).toEqual([dids[0]]);
    expect(result.failed).toBe(1);
    expect(result.completed).toBe(0);
    // The stop reason is surfaced in the batch errors.
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].sourceDid).toBe(dids[0]);
  });

  it('continueOnError=true: keeps processing after returned failures', async () => {
    const { manager } = makeManager();

    const attempted: string[] = [];
    (manager as unknown as { migrate: (o: MigrationOptions) => Promise<MigrationResult> }).migrate =
      async (options: MigrationOptions): Promise<MigrationResult> => {
        attempted.push(options.sourceDid);
        return {
          migrationId: `mig_${attempted.length}`,
          success: false,
          sourceDid: options.sourceDid,
          sourceLayer: 'peer',
          targetLayer: options.targetLayer,
          state: MigrationStateEnum.FAILED,
          duration: 1,
          cost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }
        };
      };

    const dids = ['did:peer:z6MkOne', 'did:peer:z6MkTwo', 'did:peer:z6MkThree'];
    const result = await manager.migrateBatch(dids, 'webvh', {
      sourceDid: dids[0],
      targetLayer: 'webvh',
      continueOnError: true
    });

    expect(attempted.length).toBe(3);
    expect(result.failed).toBe(3);
  });
});
