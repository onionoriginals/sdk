/**
 * Checkpoint cleanup failures: surfaced + self-healing, still non-fatal (#323).
 *
 * CheckpointManager.deleteCheckpoint is garbage collection of a checkpoint
 * whose migration already completed successfully (its only caller is a
 * fire-and-forget 24h timer in MigrationManager). A failed durable delete
 * must therefore NEVER throw into that timer — but it also must not vanish
 * into a bare console.error while the checkpoint silently lingers.
 *
 * Contract under test:
 *  1. deleteCheckpoint never rejects, even on storage failure (non-fatal).
 *  2. The failure is OBSERVABLE: structured Logger entry + telemetry hooks
 *     (config.telemetry.onEvent / onError with a StructuredError).
 *  3. The failure is SELF-HEALING: a durable per-checkpoint pending-deletion
 *     marker is written under its own immutable key
 *     (checkpoints/pending-deletion/<checkpointId>.json) and retried by
 *     cleanupOldCheckpoints (native enumeration) or the next explicit
 *     deleteCheckpoint of that id; a successful retry clears the marker.
 *  4. NO shared mutable pending-index object is ever written — markers are
 *     strictly one-object-per-checkpoint (no cross-process read-modify-write
 *     race, per the audit-index fix on this branch).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { CheckpointManager } from '../../../src/migration/checkpoint/CheckpointManager';
import { CheckpointStorage } from '../../../src/migration/checkpoint/CheckpointStorage';
import { MIGRATION_STORAGE_DOMAIN } from '../../../src/migration/storage/MigrationStorage';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import type { LogEntry } from '../../../src/utils/Logger';
import type { TelemetryEvent } from '../../../src/utils/telemetry';
import { StructuredError } from '../../../src/utils/telemetry';

const PENDING_PREFIX = 'checkpoints/pending-deletion/';
const TOMBSTONE = '__originals_deleted__';

/**
 * Canonical StorageAdapter-shaped in-memory adapter (putObject/getObject/
 * listObjects — same shape as the shipped adapters) with per-key write
 * failure injection.
 */
class FlakyCanonicalAdapter {
  store = new Map<string, string>();
  /** Writes whose PATH matches this regex throw. null = healthy. */
  failWritesMatching: RegExp | null = null;

  private key(domain: string, path: string): string {
    return `${domain}::${path.replace(/^\/+/, '')}`;
  }

  async putObject(domain: string, path: string, content: Uint8Array | string): Promise<string> {
    if (this.failWritesMatching && this.failWritesMatching.test(path)) {
      throw new Error(`injected write failure for ${path}`);
    }
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    this.store.set(this.key(domain, path), text);
    return `mem://${domain}/${path}`;
  }

  async getObject(domain: string, path: string): Promise<{ content: Uint8Array } | null> {
    const text = this.store.get(this.key(domain, path));
    if (text === undefined) return null;
    return { content: new TextEncoder().encode(text) };
  }

  async listObjects(domain: string, prefix: string): Promise<string[]> {
    const domainPrefix = `${domain}::`;
    const cleanPrefix = prefix.replace(/^\/+/, '');
    const out: string[] = [];
    for (const k of this.store.keys()) {
      if (!k.startsWith(domainPrefix)) continue;
      const path = k.slice(domainPrefix.length);
      if (path.startsWith(cleanPrefix)) out.push(path);
    }
    return out;
  }

  /** Raw stored text at a migration-domain path (test helper). */
  raw(path: string): string | undefined {
    return this.store.get(this.key(MIGRATION_STORAGE_DOMAIN, path));
  }
}

/** Legacy duck-typed adapter (put/get only): opaque — cannot enumerate. */
class OpaqueLegacyAdapter {
  store = new Map<string, string>();
  failWritesMatching: RegExp | null = null;

  async put(key: string, data: Buffer | string): Promise<string> {
    if (this.failWritesMatching && this.failWritesMatching.test(key)) {
      throw new Error(`injected write failure for ${key}`);
    }
    this.store.set(key, typeof data === 'string' ? data : data.toString('utf8'));
    return key;
  }

  async get(key: string): Promise<{ content: Buffer } | null> {
    const text = this.store.get(key);
    return text === undefined ? null : { content: Buffer.from(text, 'utf8') };
  }
}

interface Spies {
  logEntries: LogEntry[];
  telemetryEvents: TelemetryEvent[];
  telemetryErrors: StructuredError[];
}

async function makeHarness(adapter: unknown): Promise<{
  sdk: OriginalsSDK;
  manager: CheckpointManager;
  config: unknown;
  spies: Spies;
}> {
  MigrationManager.resetInstance();
  const spies: Spies = { logEntries: [], telemetryEvents: [], telemetryErrors: [] };
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageAdapter: adapter as any,
    logging: {
      level: 'debug',
      outputs: [{ write: (entry: LogEntry) => { spies.logEntries.push(entry); } }]
    },
    telemetry: {
      onEvent: (event) => { spies.telemetryEvents.push(event); },
      onError: (error) => { spies.telemetryErrors.push(error); }
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = (sdk as any)['config'];
  const manager = new CheckpointManager(config, sdk.did, sdk.credentials);
  return { sdk, manager, config, spies };
}

async function createCheckpointFor(sdk: OriginalsSDK, manager: CheckpointManager, migrationId: string) {
  const peerDid = await sdk.did.createDIDPeer([
    { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
  ]);
  return manager.createCheckpoint(migrationId, {
    sourceDid: peerDid.id,
    targetLayer: 'webvh' as const,
    domain: 'example.com'
  });
}

beforeEach(() => {
  MigrationManager.resetInstance();
});

describe('deleteCheckpoint failure: non-fatal, observable, marker written', () => {
  it('does not throw, logs via structured Logger + telemetry, and writes a per-checkpoint pending-deletion marker', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager, spies } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_fail_001');
    const id = checkpoint.checkpointId;

    // Fail the durable delete (canonical adapters delete via tombstone write
    // at checkpoints/<id>.json; pending markers live under a different path).
    adapter.failWritesMatching = /^checkpoints\/chk_/;

    // 1. Non-fatal: resolves despite the storage failure.
    await expect(manager.deleteCheckpoint(id)).resolves.toBeUndefined();

    // 2a. Structured Logger: error-level entry from CheckpointManager.
    const errorLogs = spies.logEntries.filter(
      (e) => e.level === 'error' && e.context === 'CheckpointManager'
    );
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs.some((e) => e.message.includes(id))).toBe(true);

    // 2b. Telemetry hooks: structured event AND StructuredError.
    const cleanupEvents = spies.telemetryEvents.filter(
      (e) => e.name === 'migration.checkpoint.cleanup_failed'
    );
    expect(cleanupEvents.length).toBe(1);
    expect(cleanupEvents[0].attributes?.checkpointId).toBe(id);
    expect(spies.telemetryErrors.length).toBe(1);
    expect(spies.telemetryErrors[0]).toBeInstanceOf(StructuredError);
    expect(spies.telemetryErrors[0].code).toBe('CHECKPOINT_CLEANUP_FAILED');

    // 3. Durable per-checkpoint pending-deletion marker exists.
    const markerText = adapter.raw(`${PENDING_PREFIX}${id}.json`);
    expect(markerText).toBeDefined();
    const marker = JSON.parse(markerText!) as Record<string, unknown>;
    expect(marker.checkpointId).toBe(id);
    expect(typeof marker.recordedAt).toBe('number');
  });
});

describe('self-healing retry', () => {
  it('cleanupOldCheckpoints retries the pending deletion once storage is healthy, deletes the checkpoint and clears the marker', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager, config } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_retry_001');
    const id = checkpoint.checkpointId;

    adapter.failWritesMatching = /^checkpoints\/chk_/;
    await manager.deleteCheckpoint(id);
    expect(adapter.raw(`${PENDING_PREFIX}${id}.json`)).toBeDefined();

    // Storage recovers.
    adapter.failWritesMatching = null;
    await manager.cleanupOldCheckpoints();

    // A fresh reader (empty in-memory cache) no longer sees the checkpoint.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const freshStorage = new CheckpointStorage(config as any);
    expect(await freshStorage.get(id)).toBeNull();

    // The pending marker is cleared: either removed or tombstoned.
    const markerText = adapter.raw(`${PENDING_PREFIX}${id}.json`);
    if (markerText !== undefined) {
      const marker = JSON.parse(markerText) as Record<string, unknown>;
      expect(marker[TOMBSTONE]).toBe(true);
    }

    // And a subsequent retry pass finds nothing pending (marker is inert).
    const second = await manager.retryPendingDeletions();
    expect(second.retried).toEqual([]);
    expect(second.failed).toEqual([]);
  });

  it('keeps the marker (and reports failure) while storage is still broken, without throwing', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_retry_002');
    const id = checkpoint.checkpointId;

    adapter.failWritesMatching = /^checkpoints\/chk_/;
    await manager.deleteCheckpoint(id);

    // Still broken: retry must not throw, marker must survive for next pass.
    const result = await manager.retryPendingDeletions();
    expect(result.retried).toEqual([]);
    expect(result.failed).toEqual([id]);
    const markerText = adapter.raw(`${PENDING_PREFIX}${id}.json`);
    expect(markerText).toBeDefined();
    expect((JSON.parse(markerText!) as Record<string, unknown>)[TOMBSTONE]).toBeUndefined();
  });

  it('a later successful explicit deleteCheckpoint clears the pending marker (opaque-adapter degradation path)', async () => {
    const adapter = new OpaqueLegacyAdapter();
    const { sdk, manager } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_opaque_001');
    const id = checkpoint.checkpointId;

    adapter.failWritesMatching = new RegExp(`^checkpoints/${id}`);
    await expect(manager.deleteCheckpoint(id)).resolves.toBeUndefined();
    // Marker written under its own key (legacy adapters use raw keys).
    expect(adapter.store.get(`${PENDING_PREFIX}${id}.json`)).toBeDefined();

    // Opaque adapter cannot enumerate: retry pass degrades gracefully (no-op).
    const result = await manager.retryPendingDeletions();
    expect(result.retried).toEqual([]);
    expect(result.failed).toEqual([]);

    // Best-effort path: the next explicit deleteCheckpoint of this id, with
    // storage healthy again, durably deletes AND clears the marker.
    adapter.failWritesMatching = null;
    await manager.deleteCheckpoint(id);
    const markerText = adapter.store.get(`${PENDING_PREFIX}${id}.json`);
    expect(markerText).toBeDefined(); // tombstoned in place (no native delete)
    expect((JSON.parse(markerText!) as Record<string, unknown>)[TOMBSTONE]).toBe(true);
    // Checkpoint itself reads back as gone via tombstone.
    const checkpointText = adapter.store.get(`checkpoints/${id}.json`);
    expect((JSON.parse(checkpointText!) as Record<string, unknown>)[TOMBSTONE]).toBe(true);
  });
});

describe('no shared mutable pending-index object', () => {
  it('writes one immutable marker per checkpoint and never an aggregate index', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager } = await makeHarness(adapter);
    const c1 = await createCheckpointFor(sdk, manager, 'mig_idx_001');
    const c2 = await createCheckpointFor(sdk, manager, 'mig_idx_002');

    adapter.failWritesMatching = /^checkpoints\/chk_/;
    await manager.deleteCheckpoint(c1.checkpointId);
    await manager.deleteCheckpoint(c2.checkpointId);

    const pendingPaths = await adapter.listObjects(MIGRATION_STORAGE_DOMAIN, PENDING_PREFIX);
    // Exactly the two per-checkpoint markers — nothing else under the prefix.
    expect(pendingPaths.sort()).toEqual(
      [`${PENDING_PREFIX}${c1.checkpointId}.json`, `${PENDING_PREFIX}${c2.checkpointId}.json`].sort()
    );
    // Each marker references ONLY its own checkpoint (no aggregate list).
    for (const p of pendingPaths) {
      const marker = JSON.parse(adapter.raw(p)!) as Record<string, unknown>;
      const other = p.includes(c1.checkpointId) ? c2.checkpointId : c1.checkpointId;
      expect(marker.checkpointId).toBe(p.slice(PENDING_PREFIX.length, -'.json'.length));
      expect(adapter.raw(p)!.includes(other)).toBe(false);
    }
    // No shared index object anywhere under checkpoints/.
    const allCheckpointPaths = await adapter.listObjects(MIGRATION_STORAGE_DOMAIN, 'checkpoints/');
    const aggregates = allCheckpointPaths.filter((p) => /index|pending-deletions/.test(p));
    expect(aggregates).toEqual([]);
  });
});

describe('happy path', () => {
  it('a successful deleteCheckpoint writes no pending marker and logs no error', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager, spies } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_happy_001');
    const id = checkpoint.checkpointId;

    await manager.deleteCheckpoint(id);

    expect(adapter.raw(`${PENDING_PREFIX}${id}.json`)).toBeUndefined();
    const pendingPaths = await adapter.listObjects(MIGRATION_STORAGE_DOMAIN, PENDING_PREFIX);
    expect(pendingPaths).toEqual([]);
    expect(spies.logEntries.filter((e) => e.level === 'error')).toEqual([]);
    expect(spies.telemetryErrors).toEqual([]);
    expect(
      spies.telemetryEvents.filter((e) => e.name === 'migration.checkpoint.cleanup_failed')
    ).toEqual([]);

    // Checkpoint is really gone for a fresh reader.
    expect(await manager.getCheckpoint(id)).toBeNull();
  });
});

describe('regression: cleanup failure never breaks a migration flow', () => {
  it('deleteCheckpoint resolves even when storage rejects EVERY write (marker write included)', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager, spies } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_total_001');

    adapter.failWritesMatching = /.*/; // total storage outage

    // The fire-and-forget 24h cleanup path must never see a rejection.
    await expect(manager.deleteCheckpoint(checkpoint.checkpointId)).resolves.toBeUndefined();
    // cleanupOldCheckpoints (the other GC entrypoint) is equally non-fatal.
    await expect(manager.cleanupOldCheckpoints()).resolves.toBeUndefined();
    // The failure was still surfaced.
    expect(spies.telemetryErrors.some((e) => e.code === 'CHECKPOINT_CLEANUP_FAILED')).toBe(true);
  });
});
