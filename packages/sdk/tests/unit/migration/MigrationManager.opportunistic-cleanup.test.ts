/**
 * Opportunistic checkpoint cleanup is reachable automatically (#323 review,
 * Greptile P1 "Cleanup sweep is unreachable").
 *
 * The self-healing sweep (retryPendingDeletions + storage-truth sweep) lives
 * in CheckpointManager.cleanupOldCheckpoints, but nothing in normal SDK
 * operation invoked it: the per-migration 24h timer only ran a one-shot
 * deleteCheckpoint(id), and that timer dies with the process. So a checkpoint
 * stranded by a delete that failed during a storage outage — with its
 * in-memory timer and pending-marker lost on restart — was never reclaimed
 * unless an application called cleanupOldCheckpoints() by hand.
 *
 * Fix: MigrationManager.migrate() opportunistically (throttled, best-effort)
 * triggers cleanupOldCheckpoints on the next migration, so post-restart
 * orphans are swept on the next activity. The 24h timer also now runs the full
 * cleanup rather than a bare targeted delete.
 *
 * Contract under test:
 *  1. A checkpoint stranded in storage (backdated past the 24h cutoff, no
 *     in-memory entry, no pending marker — the exact post-restart shape) is
 *     reclaimed by a subsequent migrate() WITHOUT any manual cleanup call.
 *  2. The trigger is throttled: a second migrate() inside the interval does
 *     not run the sweep again.
 *  3. estimateCostOnly requests stay read-only: they do not trigger the sweep.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import { CheckpointManager } from '../../../src/migration/checkpoint/CheckpointManager';
import { CheckpointStorage } from '../../../src/migration/checkpoint/CheckpointStorage';
import { MIGRATION_STORAGE_DOMAIN } from '../../../src/migration/storage/MigrationStorage';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import type { OriginalsConfig } from '../../../src/types';

const HOUR = 60 * 60 * 1000;
const TOMBSTONE = '__originals_deleted__';

function makeManager() {
  MigrationManager.resetInstance();
  const adapter = new MemoryStorageAdapter();
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    webvhNetwork: 'magby',
    defaultKeyType: 'Ed25519',
    enableLogging: false,
    storageAdapter: adapter
  });
  const config = (sdk as unknown as { config: OriginalsConfig }).config;
  const manager = MigrationManager.getInstance(config, sdk.did, sdk.credentials);
  return { sdk, manager, config, adapter };
}

/**
 * Wrap the manager's private CheckpointManager.cleanupOldCheckpoints so the
 * test can (a) count invocations and (b) await the fire-and-forget sweep the
 * opportunistic trigger kicks off without blocking migrate().
 */
function instrumentCleanup(manager: MigrationManager): {
  calls: () => number;
  settled: () => Promise<void>;
} {
  const cpm = (manager as unknown as { checkpointManager: CheckpointManager }).checkpointManager;
  const original = cpm.cleanupOldCheckpoints.bind(cpm);
  let calls = 0;
  const pending: Promise<void>[] = [];
  cpm.cleanupOldCheckpoints = () => {
    calls++;
    const p = original();
    pending.push(p);
    return p;
  };
  return {
    calls: () => calls,
    settled: async () => {
      await Promise.all(pending);
    }
  };
}

/** Plant a checkpoint object directly in durable storage (no in-memory entry). */
async function plantStaleCheckpoint(
  adapter: MemoryStorageAdapter,
  checkpointId: string,
  ageMs: number
): Promise<void> {
  await adapter.putObject(
    MIGRATION_STORAGE_DOMAIN,
    `checkpoints/${checkpointId}.json`,
    JSON.stringify({
      checkpointId,
      migrationId: 'mig_prior_process',
      timestamp: Date.now() - ageMs,
      sourceDid: 'did:peer:z6MkStaleOrphan',
      sourceLayer: 'peer',
      targetLayer: 'webvh'
    })
  );
}

async function rawTombstoned(
  adapter: MemoryStorageAdapter,
  checkpointId: string
): Promise<boolean> {
  const obj = await adapter.getObject(MIGRATION_STORAGE_DOMAIN, `checkpoints/${checkpointId}.json`);
  if (!obj) return true; // absent counts as durably gone
  const parsed = JSON.parse(Buffer.from(obj.content).toString('utf8')) as Record<string, unknown>;
  return parsed[TOMBSTONE] === true;
}

beforeEach(() => {
  MemoryStorageAdapter.clear();
  MigrationManager.resetInstance();
});

afterEach(() => {
  MemoryStorageAdapter.clear();
  MigrationManager.resetInstance();
});

describe('MigrationManager opportunistic checkpoint cleanup (Greptile P1: sweep is reachable)', () => {
  it('a migration reclaims a checkpoint stranded by a prior process, with NO manual cleanup call', async () => {
    const { sdk, manager, config, adapter } = makeManager();
    const cleanup = instrumentCleanup(manager);

    // A checkpoint left in storage by a previous process whose delete failed
    // during an outage: older than the 24h cutoff, with no in-memory entry on
    // this fresh manager and no pending-deletion marker anywhere.
    const orphanId = 'chk_stale_orphan';
    await plantStaleCheckpoint(adapter, orphanId, 25 * HOUR);
    expect(await rawTombstoned(adapter, orphanId)).toBe(false);

    // Run a normal, unrelated migration. We never call cleanupOldCheckpoints
    // ourselves — the opportunistic trigger inside migrate() must.
    const peer = await sdk.did.createDIDPeer([
      { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
    ]);
    const result = await manager.migrate({
      sourceDid: peer.id,
      targetLayer: 'webvh',
      domain: 'example.com'
    });
    expect(result.success).toBe(true);

    // Let the fire-and-forget sweep settle.
    await cleanup.settled();
    expect(cleanup.calls()).toBe(1);

    // The stranded checkpoint was reclaimed automatically.
    expect(await rawTombstoned(adapter, orphanId)).toBe(true);
    const freshStorage = new CheckpointStorage(config);
    expect(await freshStorage.get(orphanId)).toBeNull();
  });

  it('throttles: a second migration within the interval does not re-run the sweep', async () => {
    const { sdk, manager } = makeManager();
    const cleanup = instrumentCleanup(manager);

    const p1 = await sdk.did.createDIDPeer([
      { id: 'r1', type: 'Image', contentType: 'image/png', hash: 'h1', content: 'd1' }
    ]);
    const p2 = await sdk.did.createDIDPeer([
      { id: 'r2', type: 'Image', contentType: 'image/png', hash: 'h2', content: 'd2' }
    ]);

    await manager.migrate({ sourceDid: p1.id, targetLayer: 'webvh', domain: 'example.com' });
    await manager.migrate({ sourceDid: p2.id, targetLayer: 'webvh', domain: 'example.com' });
    await cleanup.settled();

    // Only the first migration triggered the opportunistic sweep.
    expect(cleanup.calls()).toBe(1);
  });

  it('estimateCostOnly stays read-only and does not trigger the sweep', async () => {
    const { sdk, manager } = makeManager();
    const cleanup = instrumentCleanup(manager);

    const peer = await sdk.did.createDIDPeer([
      { id: 'r', type: 'Image', contentType: 'image/png', hash: 'h', content: 'd' }
    ]);
    await manager.migrate({
      sourceDid: peer.id,
      targetLayer: 'webvh',
      domain: 'example.com',
      estimateCostOnly: true
    });
    await cleanup.settled();

    expect(cleanup.calls()).toBe(0);
  });
});
