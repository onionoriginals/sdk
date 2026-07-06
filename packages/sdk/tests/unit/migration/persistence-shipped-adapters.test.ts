/**
 * Item 2 (blocker): checkpoint & audit persistence must work with the SHIPPED
 * StorageAdapter interface (putObject/getObject/exists).
 *
 * CheckpointStorage and AuditLogger previously duck-typed
 * storageAdapter.put/get/delete/list — methods that neither the public
 * StorageAdapter interface nor the shipped Memory/Local adapters define. The
 * typeof guards skipped silently, so checkpoints and the signed audit trail
 * were NEVER persisted: after a crash (fresh process, empty in-memory maps),
 * rollback() found nothing and quarantined.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { CheckpointStorage } from '../../../src/migration/checkpoint/CheckpointStorage';
import { AuditLogger } from '../../../src/migration/audit/AuditLogger';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { LocalStorageAdapter } from '../../../src/storage/LocalStorageAdapter';
import { MigrationStateEnum, MigrationAuditRecord, MigrationCheckpoint } from '../../../src/migration/types';
import type { OriginalsConfig } from '../../../src/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeConfig(storageAdapter: unknown): OriginalsConfig {
  return {
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    enableLogging: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageAdapter: storageAdapter as any
  } as OriginalsConfig;
}

function makeCheckpoint(id: string): MigrationCheckpoint {
  return {
    checkpointId: id,
    migrationId: `mig_for_${id}`,
    timestamp: Date.now(),
    sourceDid: 'did:peer:z6MkPersist',
    sourceLayer: 'peer',
    targetLayer: 'webvh',
    didDocument: { id: 'did:peer:z6MkPersist' } as never,
    credentials: [],
    storageReferences: {},
    lifecycleState: {},
    ownershipProofs: [],
    metadata: {}
  };
}

function makeAuditRecord(overrides: Partial<MigrationAuditRecord> = {}): MigrationAuditRecord {
  return {
    migrationId: 'mig_audit_persist_001',
    timestamp: 1700000000000,
    initiator: 'system',
    sourceDid: 'did:peer:z6MkAuditPersist',
    sourceLayer: 'peer',
    targetDid: 'did:webvh:example.com:user:persist',
    targetLayer: 'webvh',
    finalState: MigrationStateEnum.COMPLETED,
    validationResults: {
      valid: true,
      errors: [],
      warnings: [],
      estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, estimatedDuration: 1, currency: 'sats' },
      estimatedDuration: 1
    },
    costActual: { storageCost: 0, networkFees: 0, totalCost: 0, estimatedDuration: 1, currency: 'sats' },
    duration: 5,
    errors: [],
    metadata: {},
    ...overrides
  };
}

beforeEach(() => {
  MemoryStorageAdapter.clear();
});

describe('CheckpointStorage persists through the shipped StorageAdapter interface', () => {
  it('a checkpoint saved with MemoryStorageAdapter survives loss of the in-memory map', async () => {
    const config = makeConfig(new MemoryStorageAdapter());
    const storageA = new CheckpointStorage(config);
    await storageA.save(makeCheckpoint('chk_mem_persist'));

    // Fresh instance = crash simulation: empty in-memory map, same adapter.
    const storageB = new CheckpointStorage(config);
    const loaded = await storageB.get('chk_mem_persist');
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpointId).toBe('chk_mem_persist');
    expect(loaded!.sourceDid).toBe('did:peer:z6MkPersist');
  });

  it('a checkpoint saved with LocalStorageAdapter survives loss of the in-memory map', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-chk-'));
    try {
      const config = makeConfig(new LocalStorageAdapter({ baseDir: dir }));
      const storageA = new CheckpointStorage(config);
      await storageA.save(makeCheckpoint('chk_local_persist'));

      const storageB = new CheckpointStorage(config);
      const loaded = await storageB.get('chk_local_persist');
      expect(loaded).not.toBeNull();
      expect(loaded!.checkpointId).toBe('chk_local_persist');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delete removes a persisted checkpoint so a fresh instance no longer sees it', async () => {
    const config = makeConfig(new MemoryStorageAdapter());
    const storageA = new CheckpointStorage(config);
    await storageA.save(makeCheckpoint('chk_deleted'));

    const storageB = new CheckpointStorage(config);
    expect(await storageB.get('chk_deleted')).not.toBeNull();
    await storageB.delete('chk_deleted');

    const storageC = new CheckpointStorage(config);
    expect(await storageC.get('chk_deleted')).toBeNull();
  });

  it('hybrid adapter (canonical + legacy delete): delete tombstones instead of hitting the raw legacy key', async () => {
    // Adapter exposing BOTH the canonical StorageAdapter interface and a
    // legacy delete(). Writes/reads go through the canonical domain-scoped
    // keys, so a legacy raw-key delete would miss the canonical object: the
    // "deleted" checkpoint would survive and a fresh reader could recover it.
    const objects = new Map<string, string>();
    const legacyDeletedKeys: string[] = [];
    const hybridAdapter = {
      async putObject(domain: string, p: string, content: Uint8Array | string) {
        objects.set(`${domain}/${p}`, typeof content === 'string' ? content : Buffer.from(content).toString('utf8'));
        return `${domain}/${p}`;
      },
      async getObject(domain: string, p: string) {
        const text = objects.get(`${domain}/${p}`);
        return text === undefined ? null : { content: Buffer.from(text, 'utf8'), contentType: 'application/json' };
      },
      async delete(key: string) {
        legacyDeletedKeys.push(key);
        objects.delete(key); // raw key — never matches the canonical domain-scoped key
      }
    };

    const config = makeConfig(hybridAdapter);
    const storageA = new CheckpointStorage(config);
    await storageA.save(makeCheckpoint('chk_hybrid'));

    const storageB = new CheckpointStorage(config);
    expect(await storageB.get('chk_hybrid')).not.toBeNull();
    await storageB.delete('chk_hybrid');

    // The legacy raw-key delete must NOT have been used for canonical writes.
    expect(legacyDeletedKeys).toHaveLength(0);

    // A completely fresh reader must not recover the deleted checkpoint.
    const storageC = new CheckpointStorage(config);
    expect(await storageC.get('chk_hybrid')).toBeNull();
  });

  it('delete REJECTS when the tombstone write fails (canonical adapter without native delete)', async () => {
    // The tombstone putText is the ONLY durable marker that the checkpoint
    // was deleted on canonical adapters. If it fails, delete() must reject —
    // resolving would tell the caller "durably deleted" while a fresh
    // CheckpointStorage after restart can still load the checkpoint.
    let failWrites = false;
    const objects = new Map<string, string>();
    const adapter = {
      async putObject(domain: string, p: string, content: Uint8Array | string) {
        if (failWrites) throw new Error('disk full: tombstone write failed');
        objects.set(`${domain}/${p}`, typeof content === 'string' ? content : Buffer.from(content).toString('utf8'));
        return `${domain}/${p}`;
      },
      async getObject(domain: string, p: string) {
        const text = objects.get(`${domain}/${p}`);
        return text === undefined ? null : { content: Buffer.from(text, 'utf8'), contentType: 'application/json' };
      }
    };

    const config = makeConfig(adapter);
    const storageA = new CheckpointStorage(config);
    await storageA.save(makeCheckpoint('chk_tombstone_fail'));

    failWrites = true;
    await expect(storageA.delete('chk_tombstone_fail')).rejects.toThrow('disk full: tombstone write failed');

    // The checkpoint genuinely survived in durable storage — which is exactly
    // why delete() must not have reported success.
    failWrites = false;
    const fresh = new CheckpointStorage(config);
    expect(await fresh.get('chk_tombstone_fail')).not.toBeNull();
  });

  it('delete REJECTS when a legacy native delete throws', async () => {
    const objects = new Map<string, Buffer>();
    const legacyAdapter = {
      async put(key: string, data: Buffer | string) {
        objects.set(key, Buffer.from(data));
        return key;
      },
      async get(key: string) {
        const content = objects.get(key);
        return content ? { content, contentType: 'application/json' } : null;
      },
      async delete(_key: string) {
        throw new Error('native delete failed');
      }
    };

    const config = makeConfig(legacyAdapter);
    const storage = new CheckpointStorage(config);
    await storage.save(makeCheckpoint('chk_native_del_fail'));

    await expect(storage.delete('chk_native_del_fail')).rejects.toThrow('native delete failed');
  });

  it('successful delete resolves and the checkpoint is durably gone', async () => {
    const config = makeConfig(new MemoryStorageAdapter());
    const storage = new CheckpointStorage(config);
    await storage.save(makeCheckpoint('chk_happy_delete'));

    await expect(storage.delete('chk_happy_delete')).resolves.toBeUndefined();

    expect(await storage.get('chk_happy_delete')).toBeNull();
    // Fresh instance (restart simulation) sees the tombstone, not the checkpoint.
    const fresh = new CheckpointStorage(config);
    expect(await fresh.get('chk_happy_delete')).toBeNull();
  });

  it('still supports legacy duck-typed put/get adapters', async () => {
    const objects = new Map<string, Buffer>();
    const legacyAdapter = {
      async put(key: string, data: Buffer | string) {
        objects.set(key, Buffer.from(data));
        return key;
      },
      async get(key: string) {
        const content = objects.get(key);
        return content ? { content, contentType: 'application/json' } : null;
      }
    };
    const config = makeConfig(legacyAdapter);
    const storageA = new CheckpointStorage(config);
    await storageA.save(makeCheckpoint('chk_legacy'));
    expect(objects.size).toBeGreaterThan(0);

    const storageB = new CheckpointStorage(config);
    const loaded = await storageB.get('chk_legacy');
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpointId).toBe('chk_legacy');
  });
});

describe('AuditLogger persists through the shipped StorageAdapter interface', () => {
  it('an audit record logged with MemoryStorageAdapter is loadable by a fresh logger', async () => {
    const config = makeConfig(new MemoryStorageAdapter());
    const loggerA = new AuditLogger(config);
    const record = makeAuditRecord();
    await loggerA.logMigration(record);

    // Fresh logger = crash simulation: empty in-memory records.
    const loggerB = new AuditLogger(config);
    expect(await loggerB.getMigrationHistory(record.sourceDid)).toHaveLength(0);
    await loggerB.loadAuditRecords(record.sourceDid);
    const history = await loggerB.getMigrationHistory(record.sourceDid);
    expect(history).toHaveLength(1);
    expect(history[0].migrationId).toBe(record.migrationId);
    expect(history[0].signature).toBeDefined();
    // The reloaded record still verifies (integrity preserved across storage).
    expect(await loggerB.verifyAuditRecord(history[0])).toBe(true);
  });

  it('an audit record logged with LocalStorageAdapter is loadable by a fresh logger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-audit-'));
    try {
      const config = makeConfig(new LocalStorageAdapter({ baseDir: dir }));
      const loggerA = new AuditLogger(config);
      const record = makeAuditRecord({ migrationId: 'mig_audit_local' });
      await loggerA.logMigration(record);

      const loggerB = new AuditLogger(config);
      await loggerB.loadAuditRecords(record.sourceDid);
      const history = await loggerB.getMigrationHistory(record.sourceDid);
      expect(history).toHaveLength(1);
      expect(history[0].migrationId).toBe('mig_audit_local');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records are append-only: multiple migrations of the same DID are all reloadable', async () => {
    const config = makeConfig(new MemoryStorageAdapter());
    const loggerA = new AuditLogger(config);
    await loggerA.logMigration(makeAuditRecord({ migrationId: 'mig_a1', timestamp: 1700000000001 }));
    await loggerA.logMigration(makeAuditRecord({ migrationId: 'mig_a2', timestamp: 1700000000002 }));
    await loggerA.logMigration(makeAuditRecord({
      migrationId: 'mig_a2',
      timestamp: 1700000000003,
      finalState: MigrationStateEnum.FAILED
    }));

    const loggerB = new AuditLogger(config);
    await loggerB.loadAuditRecords('did:peer:z6MkAuditPersist');
    const history = await loggerB.getMigrationHistory('did:peer:z6MkAuditPersist');
    expect(history.length).toBe(3);
  });

  it('two AuditLogger instances sharing one adapter do not lose each other\'s index entries', async () => {
    const config = makeConfig(new MemoryStorageAdapter());
    const did = 'did:peer:z6MkConcurrentIndex';
    const loggerA = new AuditLogger(config);
    const loggerB = new AuditLogger(config);

    // Concurrent read-modify-write of the shared audit index: without
    // cross-instance serialization/merging, both loggers read the same index
    // snapshot and the later write silently drops the earlier key, making
    // that record undiscoverable after restart.
    await Promise.all([
      loggerA.logMigration(makeAuditRecord({
        migrationId: 'mig_conc_a', sourceDid: did, targetDid: null, timestamp: 1700000000101
      })),
      loggerB.logMigration(makeAuditRecord({
        migrationId: 'mig_conc_b', sourceDid: did, targetDid: null, timestamp: 1700000000102
      }))
    ]);

    // Fresh logger = restart simulation: both records must be discoverable.
    const fresh = new AuditLogger(config);
    await fresh.loadAuditRecords(did);
    const history = await fresh.getMigrationHistory(did);
    expect(history.map(r => r.migrationId).sort()).toEqual(['mig_conc_a', 'mig_conc_b']);
  });

  it('audit persistence failures propagate so callers can surface auditPersisted:false', async () => {
    const failingAdapter = {
      putObject: async () => {
        throw new Error('disk full');
      },
      getObject: async () => null,
      exists: async () => false
    };
    const logger = new AuditLogger(makeConfig(failingAdapter));
    await expect(logger.logMigration(makeAuditRecord())).rejects.toThrow('disk full');
  });
});
