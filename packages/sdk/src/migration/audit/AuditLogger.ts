/**
 * AuditLogger - Creates and manages migration audit records
 */

import { MigrationAuditRecord, IAuditLogger } from '../types';
import { OriginalsConfig } from '../../types';
import { sha256 } from '@noble/hashes/sha2.js';
import * as ed25519 from '@noble/ed25519';
import { encodeBase64UrlMultibase, base58, MULTIBASE_BASE58BTC_HEADER } from '../../utils/encoding';

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

    // Store by source DID
    const existingRecords = this.auditRecords.get(record.sourceDid) || [];
    existingRecords.push(signedRecord);
    this.auditRecords.set(record.sourceDid, existingRecords);

    // Also store by target DID if available
    if (record.targetDid) {
      const targetRecords = this.auditRecords.get(record.targetDid) || [];
      targetRecords.push(signedRecord);
      this.auditRecords.set(record.targetDid, targetRecords);
    }

    // Persist to storage if available (append-only, never overwrite)
    await this.persistAuditRecord(signedRecord);
  }

  /**
   * Get migration history for a DID
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getMigrationHistory(did: string): Promise<MigrationAuditRecord[]> {
    return this.auditRecords.get(did) || [];
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
          allRecords.push(record);
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
        Buffer.from(canonical).toString('hex'),
        Buffer.from(this.signerConfig.privateKey).toString('hex')
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
          Buffer.from(sig).toString('hex'),
          Buffer.from(canonical).toString('hex'),
          Buffer.from(this.signerConfig.publicKey).toString('hex')
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
   * Persist audit record to storage (append-only, never overwrite)
   * Updated key design: audit/migrations/{migrationId}/{timestamp}-{finalState}.json
   */
  private async persistAuditRecord(record: MigrationAuditRecord): Promise<void> {
    const storageAdapter = (this.config as any).storageAdapter;
    if (storageAdapter && typeof storageAdapter.put === 'function') {
      try {
        const data = JSON.stringify(record);
        // Use unique key to prevent overwriting: migrationId/timestamp-state
        const key = `audit/migrations/${record.migrationId}/${record.timestamp}-${record.finalState}.json`;
        await storageAdapter.put(key, Buffer.from(data), { contentType: 'application/json' });
      } catch (error) {
        console.error('Failed to persist audit record:', error);
        // Continue - in-memory record is still available
      }
    }
  }

  /**
   * Load audit records from storage
   */
  async loadAuditRecords(did: string): Promise<void> {
    const storageAdapter = (this.config as any).storageAdapter;
    if (!storageAdapter || typeof storageAdapter.list !== 'function') {
      return;
    }

    try {
      // List all audit records
      const files = await storageAdapter.list('audit/migrations/');

      for (const file of files) {
        try {
          const data = await storageAdapter.get(file);
          if (data) {
            const record: MigrationAuditRecord = JSON.parse(data.toString());

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
