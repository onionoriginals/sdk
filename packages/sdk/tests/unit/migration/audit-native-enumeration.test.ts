/**
 * Cross-process audit-index race (#323): with the shipped adapters, audit
 * records live at UNIQUE immutable keys, so concurrent writers never
 * overwrite each other's record objects. The only shared mutable object was
 * the audit index (audit/migrations/index.json) — a read-modify-write list
 * that existed solely because the canonical StorageAdapter cannot list.
 *
 * The shipped adapters now enumerate natively via listObjects(), so for them
 * the AuditLogger must NOT write the index at all: no shared mutable object
 * exists, hence no cross-process lost-update is possible. The index remains
 * only as a fallback for opaque adapters that implement neither `list` nor
 * `listObjects`.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuditLogger } from '../../../src/migration/audit/AuditLogger';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { LocalStorageAdapter } from '../../../src/storage/LocalStorageAdapter';
import { MIGRATION_STORAGE_DOMAIN } from '../../../src/migration/storage/MigrationStorage';
import { MigrationStateEnum, MigrationAuditRecord } from '../../../src/migration/types';
import type { OriginalsConfig } from '../../../src/types';

const AUDIT_INDEX_KEY = 'audit/migrations/index.json';

function makeConfig(storageAdapter: unknown): OriginalsConfig {
  return {
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    enableLogging: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageAdapter: storageAdapter as any
  } as OriginalsConfig;
}

function makeAuditRecord(overrides: Partial<MigrationAuditRecord> = {}): MigrationAuditRecord {
  return {
    migrationId: 'mig_enum_001',
    timestamp: 1700000000000,
    initiator: 'system',
    sourceDid: 'did:peer:z6MkEnum',
    sourceLayer: 'peer',
    targetDid: null,
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

describe('AuditLogger with natively-enumerable shipped adapters (no shared index)', () => {
  it('never writes the shared index object with MemoryStorageAdapter (the race source is gone)', async () => {
    const adapter = new MemoryStorageAdapter();
    const config = makeConfig(adapter);
    const logger = new AuditLogger(config);
    await logger.logMigration(makeAuditRecord());

    // The record itself was persisted...
    const listed = await adapter.listObjects(MIGRATION_STORAGE_DOMAIN, 'audit/migrations/');
    expect(listed.length).toBe(1);
    // ...but NO shared mutable index object exists to race on.
    expect(await adapter.getObject(MIGRATION_STORAGE_DOMAIN, AUDIT_INDEX_KEY)).toBeNull();
    expect(listed).not.toContain(AUDIT_INDEX_KEY);
  });

  it('multiple independent loggers (no shared in-process state needed): a fresh logger discovers ALL records via enumeration', async () => {
    const adapter = new MemoryStorageAdapter();
    const did = 'did:peer:z6MkTwoWriters';
    const otherDid = 'did:peer:z6MkOtherWriter';

    // Two writers, each its own AuditLogger instance and its own config —
    // like two processes, no correctness dependence on a shared in-process
    // lock. Records land at unique immutable keys and no shared index object
    // is read-modified-written, so nothing can be lost.
    const loggerA = new AuditLogger(makeConfig(adapter));
    const loggerB = new AuditLogger(makeConfig(adapter));
    await Promise.all([
      loggerA.logMigration(makeAuditRecord({ migrationId: 'mig_w_a1', sourceDid: did, timestamp: 1700000000101 })),
      loggerB.logMigration(makeAuditRecord({ migrationId: 'mig_w_b1', sourceDid: did, timestamp: 1700000000102 })),
      loggerA.logMigration(makeAuditRecord({ migrationId: 'mig_w_a2', sourceDid: otherDid, timestamp: 1700000000103 })),
      loggerB.logMigration(makeAuditRecord({ migrationId: 'mig_w_b2', sourceDid: otherDid, timestamp: 1700000000104 }))
    ]);

    // No shared index object was ever written.
    expect(await adapter.getObject(MIGRATION_STORAGE_DOMAIN, AUDIT_INDEX_KEY)).toBeNull();

    // Restart simulation: a completely fresh logger discovers every record.
    const fresh = new AuditLogger(makeConfig(adapter));
    await fresh.loadAuditRecords(did);
    await fresh.loadAuditRecords(otherDid);
    const historyDid = await fresh.getMigrationHistory(did);
    const historyOther = await fresh.getMigrationHistory(otherDid);
    expect(historyDid.map(r => r.migrationId).sort()).toEqual(['mig_w_a1', 'mig_w_b1']);
    expect(historyOther.map(r => r.migrationId).sort()).toEqual(['mig_w_a2', 'mig_w_b2']);
  });

  it('never writes the shared index with LocalStorageAdapter; a fresh logger discovers records by walking the store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-audit-enum-'));
    try {
      const adapter = new LocalStorageAdapter({ baseDir: dir });
      const did = 'did:peer:z6MkLocalEnum';
      const loggerA = new AuditLogger(makeConfig(adapter));
      const loggerB = new AuditLogger(makeConfig(adapter));
      await Promise.all([
        loggerA.logMigration(makeAuditRecord({ migrationId: 'mig_l_a', sourceDid: did, timestamp: 1700000000201 })),
        loggerB.logMigration(makeAuditRecord({ migrationId: 'mig_l_b', sourceDid: did, timestamp: 1700000000202 }))
      ]);

      expect(await adapter.getObject(MIGRATION_STORAGE_DOMAIN, AUDIT_INDEX_KEY)).toBeNull();

      const fresh = new AuditLogger(makeConfig(adapter));
      await fresh.loadAuditRecords(did);
      const history = await fresh.getMigrationHistory(did);
      expect(history.map(r => r.migrationId).sort()).toEqual(['mig_l_a', 'mig_l_b']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy adapter with a native list(): no index is written, discovery uses list()', async () => {
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
      async list(prefix: string) {
        return [...objects.keys()].filter(k => k.startsWith(prefix));
      }
    };
    const did = 'did:peer:z6MkLegacyList';
    const logger = new AuditLogger(makeConfig(legacyAdapter));
    await logger.logMigration(makeAuditRecord({ migrationId: 'mig_legacy_list', sourceDid: did }));

    // Enumerable adapter → no shared index object.
    expect(objects.has(AUDIT_INDEX_KEY)).toBe(false);

    const fresh = new AuditLogger(makeConfig(legacyAdapter));
    await fresh.loadAuditRecords(did);
    const history = await fresh.getMigrationHistory(did);
    expect(history.map(r => r.migrationId)).toEqual(['mig_legacy_list']);
  });

  it('opaque adapter with NEITHER list nor listObjects: index fallback is still maintained and still works', async () => {
    // Canonical-only third-party adapter that cannot enumerate — the one
    // remaining shape that needs the index (and keeps its documented
    // residual cross-process limitation).
    const objects = new Map<string, string>();
    const opaqueAdapter = {
      async putObject(domain: string, p: string, content: Uint8Array | string) {
        objects.set(`${domain}/${p}`, typeof content === 'string' ? content : Buffer.from(content).toString('utf8'));
        return `${domain}/${p}`;
      },
      async getObject(domain: string, p: string) {
        const text = objects.get(`${domain}/${p}`);
        return text === undefined ? null : { content: Buffer.from(text, 'utf8'), contentType: 'application/json' };
      },
      async exists(domain: string, p: string) {
        return objects.has(`${domain}/${p}`);
      }
    };
    const did = 'did:peer:z6MkOpaque';
    const logger = new AuditLogger(makeConfig(opaqueAdapter));
    await logger.logMigration(makeAuditRecord({ migrationId: 'mig_opaque', sourceDid: did }));

    // Non-enumerable adapter → the index fallback IS written...
    expect(objects.has(`${MIGRATION_STORAGE_DOMAIN}/${AUDIT_INDEX_KEY}`)).toBe(true);

    // ...and a fresh logger recovers the record through it.
    const fresh = new AuditLogger(makeConfig(opaqueAdapter));
    await fresh.loadAuditRecords(did);
    const history = await fresh.getMigrationHistory(did);
    expect(history.map(r => r.migrationId)).toEqual(['mig_opaque']);
  });
});
