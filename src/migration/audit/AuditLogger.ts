/**
 * AuditLogger - Creates and manages migration audit records
 */

import { MigrationAuditRecord, IAuditLogger } from '../types';
import { OriginalsConfig } from '../../types';
import { sha256 } from '@noble/hashes/sha2';
import { encodeBase64UrlMultibase } from '../../utils/encoding';

export class AuditLogger implements IAuditLogger {
  private auditRecords: Map<string, MigrationAuditRecord[]>;

  constructor(private config: OriginalsConfig) {
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

    // Persist to storage if available
    await this.persistAuditRecord(signedRecord);
  }

  /**
   * Get migration history for a DID
   */
  async getMigrationHistory(did: string): Promise<MigrationAuditRecord[]> {
    return this.auditRecords.get(did) || [];
  }

  /**
   * Get system-wide migration logs with filters
   */
  async getSystemMigrationLogs(filters: Partial<MigrationAuditRecord>): Promise<MigrationAuditRecord[]> {
    const allRecords: MigrationAuditRecord[] = [];

    // Collect all unique records
    const seen = new Set<string>();
    for (const records of this.auditRecords.values()) {
      for (const record of records) {
        if (!seen.has(record.migrationId)) {
          seen.add(record.migrationId);
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
   * Sign an audit record for integrity
   */
  private async signAuditRecord(record: MigrationAuditRecord): Promise<string> {
    // Create a canonical representation of the record (without signature)
    const { signature, ...recordWithoutSig } = record as any;
    const canonical = JSON.stringify(recordWithoutSig);

    // Hash the canonical representation
    const hash = sha256(Buffer.from(canonical, 'utf8'));

    // Encode as multibase for storage
    return encodeBase64UrlMultibase(Buffer.from(hash));
  }

  /**
   * Verify an audit record signature
   */
  async verifyAuditRecord(record: MigrationAuditRecord): Promise<boolean> {
    if (!record.signature) {
      return false;
    }

    const expectedSignature = await this.signAuditRecord(record);
    return expectedSignature === record.signature;
  }

  /**
   * Persist audit record to storage
   */
  private async persistAuditRecord(record: MigrationAuditRecord): Promise<void> {
    const storageAdapter = (this.config as any).storageAdapter;
    if (storageAdapter && typeof storageAdapter.put === 'function') {
      try {
        const data = JSON.stringify(record);
        const key = `audit/migrations/${record.migrationId}.json`;
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
              if (!existingRecords.find(r => r.migrationId === record.migrationId)) {
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
