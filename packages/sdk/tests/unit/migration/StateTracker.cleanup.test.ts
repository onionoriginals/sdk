/**
 * Item 6: StateTracker.cleanupOldStates never reclaimed FAILED/QUARANTINED
 * entries, so they accumulated unboundedly. They are now cleaned up with a
 * separate (longer, default 30 days) retention bound, since they may need
 * manual review. Also: the concurrent-rejection path in MigrationManager no
 * longer emits migration:failed + a signed audit record for a
 * MIGRATION_IN_PROGRESS rejection that never actually started.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import { StateTracker } from '../../../src/migration/state/StateTracker';
import { MigrationStateEnum, MigrationState } from '../../../src/migration/types';
import type { OriginalsConfig } from '../../../src/types';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

const DAY = 24 * 60 * 60 * 1000;

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
  storageAdapter: new MemoryStorageAdapter()
};

async function makeTerminalState(
  tracker: StateTracker,
  did: string,
  terminal: MigrationStateEnum,
  endTimeAgoMs: number
): Promise<string> {
  const state = await tracker.createMigration({ sourceDid: did, targetLayer: 'webvh', domain: 'example.com' });
  await tracker.updateState(state.migrationId, { state: MigrationStateEnum.VALIDATING });
  await tracker.updateState(state.migrationId, { state: MigrationStateEnum.CHECKPOINTED });
  await tracker.updateState(state.migrationId, { state: MigrationStateEnum.IN_PROGRESS });
  if (terminal === MigrationStateEnum.COMPLETED) {
    await tracker.updateState(state.migrationId, { state: MigrationStateEnum.COMPLETED });
  } else if (terminal === MigrationStateEnum.FAILED) {
    await tracker.updateState(state.migrationId, { state: MigrationStateEnum.FAILED });
  } else if (terminal === MigrationStateEnum.QUARANTINED) {
    await tracker.updateState(state.migrationId, { state: MigrationStateEnum.FAILED });
    await tracker.updateState(state.migrationId, { state: MigrationStateEnum.QUARANTINED });
  }
  // Backdate endTime
  const states: Map<string, MigrationState> = (tracker as unknown as { states: Map<string, MigrationState> }).states;
  const current = states.get(state.migrationId)!;
  states.set(state.migrationId, { ...current, endTime: Date.now() - endTimeAgoMs });
  return state.migrationId;
}

describe('StateTracker.cleanupOldStates reclaims FAILED/QUARANTINED (item 6)', () => {
  let tracker: StateTracker;

  beforeEach(() => {
    tracker = new StateTracker(baseConfig);
  });

  test('FAILED entries older than the failed-retention bound are reclaimed', async () => {
    const oldFailed = await makeTerminalState(tracker, 'did:peer:z6MkOldFailed', MigrationStateEnum.FAILED, 31 * DAY);
    const recentFailed = await makeTerminalState(tracker, 'did:peer:z6MkRecentFailed', MigrationStateEnum.FAILED, 1 * DAY);

    await tracker.cleanupOldStates();

    expect(await tracker.getState(oldFailed)).toBeNull();
    expect(await tracker.getState(recentFailed)).not.toBeNull();
  });

  test('QUARANTINED entries older than the failed-retention bound are reclaimed', async () => {
    const oldQuarantined = await makeTerminalState(
      tracker,
      'did:peer:z6MkOldQuarantined',
      MigrationStateEnum.QUARANTINED,
      31 * DAY
    );
    const recentQuarantined = await makeTerminalState(
      tracker,
      'did:peer:z6MkRecentQuarantined',
      MigrationStateEnum.QUARANTINED,
      8 * DAY // older than the 7d success retention, younger than the 30d failed retention
    );

    await tracker.cleanupOldStates();

    expect(await tracker.getState(oldQuarantined)).toBeNull();
    // Failure states get the LONGER retention: still under manual review.
    expect(await tracker.getState(recentQuarantined)).not.toBeNull();
  });

  test('the failed-retention bound is configurable', async () => {
    const failed = await makeTerminalState(tracker, 'did:peer:z6MkConfigurable', MigrationStateEnum.FAILED, 2 * DAY);
    await tracker.cleanupOldStates(7 * DAY, 1 * DAY);
    expect(await tracker.getState(failed)).toBeNull();
  });

  test('COMPLETED entries keep the existing (shorter) retention', async () => {
    const oldCompleted = await makeTerminalState(tracker, 'did:peer:z6MkOldCompleted', MigrationStateEnum.COMPLETED, 8 * DAY);
    await tracker.cleanupOldStates();
    expect(await tracker.getState(oldCompleted)).toBeNull();
  });
});

describe('MIGRATION_IN_PROGRESS rejection produces no audit/event noise (item 6, low-pri)', () => {
  afterEach(() => {
    MigrationManager.resetInstance();
  });

  test('a guard-rejected concurrent migrate() emits no migration:failed and writes no audit record', async () => {
    MigrationManager.resetInstance();
    const sdk = OriginalsSDK.create({ ...baseConfig });
    const manager = MigrationManager.getInstance(
      (sdk as unknown as { config: OriginalsConfig }).config,
      sdk.did,
      sdk.credentials
    );

    const peerDid = await sdk.did.createDIDPeer([
      { id: 'res-noise', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
    ]);

    const failedEvents: unknown[] = [];
    manager.on('migration:failed', (e) => {
      failedEvents.push(e);
    });

    const opts = { sourceDid: peerDid.id, targetLayer: 'webvh' as const, domain: 'example.com' };
    const [r1, r2] = await Promise.all([manager.migrate(opts), manager.migrate(opts)]);

    const results = [r1, r2];
    const rejected = results.filter((r) => r.error?.code === 'MIGRATION_IN_PROGRESS');
    const succeeded = results.filter((r) => r.success);
    expect(rejected.length).toBe(1);
    expect(succeeded.length).toBe(1);

    // The rejection never started a migration: no migration:failed noise.
    expect(failedEvents.length).toBe(0);

    // And no audit record for a migration that never began — only the
    // successful migration's record exists.
    const history = await manager.getMigrationHistory(peerDid.id);
    expect(history.length).toBe(1);
    expect(history[0].finalState).toBe(MigrationStateEnum.COMPLETED);
  });
});
