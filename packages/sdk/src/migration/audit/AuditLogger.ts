/**
 * AuditLogger - Creates and manages migration audit records
 */

import { MigrationAuditRecord, IAuditLogger } from '../types.js';
import { OriginalsConfig } from '../../types/index.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as ed25519 from '@noble/ed25519';
import { encodeBase64UrlMultibase, base58, MULTIBASE_BASE58BTC_HEADER } from '../../utils/encoding.js';
import { resolveMigrationStorage, MigrationStorage } from '../storage/MigrationStorage.js';

/**
 * Index object listing every persisted audit-record key. The canonical
 * StorageAdapter interface has no list(); the index makes persisted records
 * discoverable again after a restart.
 */
const AUDIT_INDEX_KEY = 'audit/migrations/index.json';

/**
 * Key material for signing audit records with Ed25519. When omitted, the
 * AuditLogger falls back to a keyless SHA-256 integrity hash (integrity-only:
 * anyone can recompute it; it does not authenticate the signer).
 */
export interface AuditSignerConfig {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  verificationMethod: string;
}

export class AuditLogger implements IAuditLogger {
  private auditRecords: Map<string, MigrationAuditRecord[]>;
  /**
   * Serializes read-modify-write updates of the persisted audit index so
   * concurrent migrations in one process cannot drop each other's entries.
   */
  private indexLock: Promise<void> = Promise.resolve();

  constructor(
    private config: OriginalsConfig,
    private signerConfig?: AuditSignerConfig
  ) {
    this.auditRecords = new Map();
  }

  /**
   * Log a migration audit record
   */
  async logMigration(record: MigrationAuditRecord): Promise<void> {
    // Sign the audit record
    const signature = await this.signAuditRecord(record);
    const signedRecord = { ...record, signature };

    // Store an independent deep copy per DID key. Sharing one mutable object
    // between the sourceDid and targetDid entries meant tampering via one
    // DID's history silently altered the other's (issue #281).
    const existingRecords = this.auditRecords.get(record.sourceDid) || [];
    existingRecords.push(structuredClone(signedRecord));
    this.auditRecords.set(record.sourceDid, existingRecords);

    // Also store by target DID if available
    if (record.targetDid) {
      const targetRecords = this.auditRecords.get(record.targetDid) || [];
      targetRecords.push(structuredClone(signedRecord));
      this.auditRecords.set(record.targetDid, targetRecords);
    }

    // Persist to storage if available (append-only, never overwrite)
    await this.persistAuditRecord(signedRecord);
  }

  /**
   * Get migration history for a DID.
   *
   * Returns deep copies: handing out the live internal array/objects let any
   * caller pop records or rewrite finalState/targetDid in place, corrupting
   * the "append-only" log for every future reader (issue #281).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getMigrationHistory(did: string): Promise<MigrationAuditRecord[]> {
    const records = this.auditRecords.get(did) || [];
    return records.map(record => structuredClone(record));
  }

  /**
   * Get system-wide migration logs with filters
   * Fixed dedupe logic: use signature to avoid timeline collapse
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getSystemMigrationLogs(filters: Partial<MigrationAuditRecord>): Promise<MigrationAuditRecord[]> {
    const allRecords: MigrationAuditRecord[] = [];

    // Collect all unique records (dedupe by signature to preserve timeline)
    const seen = new Set<string>();
    for (const records of this.auditRecords.values()) {
      for (const record of records) {
        const dedupKey = record.signature || `${record.migrationId}-${record.timestamp}-${record.finalState}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          // Deep copy for the same reason as getMigrationHistory (issue #281).
          allRecords.push(structuredClone(record));
        }
      }
    }

    // Apply filters
    return allRecords.filter(record => {
      for (const [key, value] of Object.entries(filters)) {
        if (record[key as keyof MigrationAuditRecord] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Produce the canonical byte representation of a record (excluding its
   * signature) used for both signing and verification.
   */
  private canonicalBytes(record: MigrationAuditRecord): Uint8Array {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { signature: _signature, ...recordWithoutSig } = record as any;
    return Buffer.from(JSON.stringify(recordWithoutSig), 'utf8');
  }

  /**
   * Sign an audit record.
   *
   * With an {@link AuditSignerConfig} configured, records are signed with
   * Ed25519 (base58btc multibase, 'z' prefix) and verification is key-bound.
   * Without one, a keyless SHA-256 integrity hash is used — this detects
   * tampering but does NOT authenticate the signer (anyone can recompute it).
   */
  private async signAuditRecord(record: MigrationAuditRecord): Promise<string> {
    const canonical = this.canonicalBytes(record);

    if (this.signerConfig) {
      const signature = await ed25519.signAsync(
        canonical,
        this.signerConfig.privateKey
      );
      return MULTIBASE_BASE58BTC_HEADER + base58.encode(signature);
    }

    // Keyless fallback: SHA-256 integrity hash (integrity-only, not signer-authenticated).
    const hash = sha256(canonical);
    return encodeBase64UrlMultibase(Buffer.from(hash));
  }

  /**
   * Verify an audit record signature
   */
  async verifyAuditRecord(record: MigrationAuditRecord): Promise<boolean> {
    if (!record.signature) {
      return false;
    }

    const canonical = this.canonicalBytes(record);

    if (this.signerConfig) {
      try {
        const sig = base58.decode(record.signature.slice(1));
        return await ed25519.verifyAsync(
          sig,
          canonical,
          this.signerConfig.publicKey
        );
      } catch {
        return false;
      }
    }

    // Keyless fallback: recompute the SHA-256 integrity hash and compare.
    const expectedSignature = encodeBase64UrlMultibase(Buffer.from(sha256(canonical)));
    return expectedSignature === record.signature;
  }

  /**
   * Persist audit record to storage (append-only, never overwrite).
   * Key design: audit/migrations/{migrationId}/{timestamp}-{finalState}.json
   *
   * Goes through resolveMigrationStorage so the shipped putObject/getObject
   * adapters persist too (previously only legacy duck-typed `put` adapters
   * did — with Memory/Local adapters the signed audit trail silently never
   * hit storage). Persistence failures PROPAGATE: MigrationManager catches
   * them and surfaces auditPersisted:false/auditError on the result instead
   * of the trail being lost silently.
   */
  private async persistAuditRecord(record: MigrationAuditRecord): Promise<void> {
    const storage = resolveMigrationStorage(this.config);
    if (!storage) return; // no adapter configured: in-memory only

    // Use unique key to prevent overwriting: migrationId/timestamp-state
    const key = `audit/migrations/${record.migrationId}/${record.timestamp}-${record.finalState}.json`;
    await storage.putText(key, JSON.stringify(record));
    await this.appendToIndex(storage, key);
  }

  /**
   * Record a persisted key in the audit index (read-modify-write, serialized
   * through indexLock). Only needed for canonical adapters, which cannot
   * list; kept for legacy adapters too so the index stays complete.
   */
  private appendToIndex(storage: MigrationStorage, key: string): Promise<void> {
    const update = this.indexLock.then(async () => {
      const keys = await this.readIndex(storage);
      if (!keys.includes(key)) {
        keys.push(key);
        await storage.putText(AUDIT_INDEX_KEY, JSON.stringify(keys));
      }
    });
    // Keep the chain alive even if this update fails, but propagate the
    // failure to THIS caller (a broken index means the record is not
    // discoverable after a restart — that is a persistence failure).
    this.indexLock = update.catch(() => undefined);
    return update;
  }

  private async readIndex(storage: MigrationStorage): Promise<string[]> {
    try {
      const text = await storage.getText(AUDIT_INDEX_KEY);
      if (!text) return [];
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Load audit records from storage
   */
  async loadAuditRecords(did: string): Promise<void> {
    const storage = resolveMigrationStorage(this.config);
    if (!storage) {
      return;
    }

    try {
      // Prefer a native list() when the (legacy) adapter offers one;
      // otherwise fall back to the persisted index maintained by
      // persistAuditRecord (the canonical StorageAdapter cannot list).
      const files = (await storage.listNative('audit/migrations/')) ?? (await this.readIndex(storage));

      for (const file of files) {
        if (file === AUDIT_INDEX_KEY) continue;
        try {
          const data = await storage.getText(file);
          if (data) {
            const record: MigrationAuditRecord = JSON.parse(data);

            // Add to in-memory store if it matches the DID
            if (record.sourceDid === did || record.targetDid === did) {
              const existingRecords = this.auditRecords.get(did) || [];
              // Use signature for dedupe to prevent timeline collapse
              const dedupKey = record.signature || `${record.migrationId}-${record.timestamp}`;
              if (!existingRecords.find(r => {
                const rKey = r.signature || `${r.migrationId}-${r.timestamp}`;
                return rKey === dedupKey;
              })) {
                existingRecords.push(record);
                this.auditRecords.set(did, existingRecords);
              }
            }
          }
        } catch (error) {
          // Skip invalid audit records
        }
      }
    } catch (error) {
      console.error('Failed to load audit records:', error);
    }
  }
}
