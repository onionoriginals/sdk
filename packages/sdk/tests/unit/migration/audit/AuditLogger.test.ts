import { describe, it, expect, beforeAll } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { AuditLogger, AuditSignerConfig } from '../../../../src/migration/audit/AuditLogger';
import { MigrationAuditRecord, MigrationStateEnum } from '../../../../src/migration/types';
import { OriginalsConfig } from '../../../../src/types';

function makeConfig(): OriginalsConfig {
  return {
    network: 'regtest',
    defaultKeyType: 'Ed25519',
  };
}

function makeAuditRecord(overrides: Partial<MigrationAuditRecord> = {}): MigrationAuditRecord {
  return {
    migrationId: 'mig_test_001',
    timestamp: 1700000000000,
    initiator: 'system',
    sourceDid: 'did:peer:0z1234',
    sourceLayer: 'peer',
    targetDid: 'did:webvh:example.com:user:alice',
    targetLayer: 'webvh',
    finalState: MigrationStateEnum.COMPLETED,
    validationResults: {
      valid: true,
      errors: [],
      warnings: [],
      estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, estimatedDuration: 100, currency: 'sats' },
      estimatedDuration: 100,
    },
    costActual: { storageCost: 0, networkFees: 0, totalCost: 0, estimatedDuration: 100, currency: 'sats' },
    duration: 500,
    errors: [],
    metadata: {},
    ...overrides,
  };
}

describe('AuditLogger', () => {
  let signerConfig: AuditSignerConfig;

  beforeAll(async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = await ed25519.getPublicKeyAsync(
      Buffer.from(privateKey).toString('hex')
    );
    signerConfig = {
      privateKey,
      publicKey,
      verificationMethod: 'did:key:z6MkTest#z6MkTest',
    };
  });

  describe('without signer (SHA256 fallback)', () => {
    it('should log and sign a record with SHA256 integrity hash', async () => {
      const logger = new AuditLogger(makeConfig());
      const record = makeAuditRecord();

      await logger.logMigration(record);

      const history = await logger.getMigrationHistory(record.sourceDid);
      expect(history).toHaveLength(1);
      expect(history[0].signature).toBeDefined();
      // SHA256 hash → 32 bytes → base58 encoded with 'z' prefix
      expect(history[0].signature!.startsWith('z')).toBe(true);
    });

    it('should verify SHA256 integrity hash', async () => {
      const logger = new AuditLogger(makeConfig());
      const record = makeAuditRecord();

      await logger.logMigration(record);

      const history = await logger.getMigrationHistory(record.sourceDid);
      const verified = await logger.verifyAuditRecord(history[0]);
      expect(verified).toBe(true);
    });

    it('should fail verification on tampered record', async () => {
      const logger = new AuditLogger(makeConfig());
      const record = makeAuditRecord();

      await logger.logMigration(record);

      const history = await logger.getMigrationHistory(record.sourceDid);
      const tampered = { ...history[0], initiator: 'attacker' };
      const verified = await logger.verifyAuditRecord(tampered);
      expect(verified).toBe(false);
    });
  });

  describe('with Ed25519 signer', () => {
    it('should sign a record with Ed25519', async () => {
      const logger = new AuditLogger(makeConfig(), signerConfig);
      const record = makeAuditRecord();

      await logger.logMigration(record);

      const history = await logger.getMigrationHistory(record.sourceDid);
      expect(history).toHaveLength(1);
      expect(history[0].signature).toBeDefined();
      // Ed25519 signature → 64 bytes → base58 encoded with 'z' prefix
      expect(history[0].signature!.startsWith('z')).toBe(true);
    });

    it('should verify Ed25519 signature', async () => {
      const logger = new AuditLogger(makeConfig(), signerConfig);
      const record = makeAuditRecord();

      await logger.logMigration(record);

      const history = await logger.getMigrationHistory(record.sourceDid);
      const verified = await logger.verifyAuditRecord(history[0]);
      expect(verified).toBe(true);
    });

    it('should fail verification on tampered record', async () => {
      const logger = new AuditLogger(makeConfig(), signerConfig);
      const record = makeAuditRecord();

      await logger.logMigration(record);

      const history = await logger.getMigrationHistory(record.sourceDid);
      const tampered = { ...history[0], duration: 9999 };
      const verified = await logger.verifyAuditRecord(tampered);
      expect(verified).toBe(false);
    });

    it('should fail verification with wrong public key', async () => {
      const logger = new AuditLogger(makeConfig(), signerConfig);
      const record = makeAuditRecord();

      await logger.logMigration(record);

      // Create a different logger with a different key pair
      const otherPrivateKey = ed25519.utils.randomPrivateKey();
      const otherPublicKey = await ed25519.getPublicKeyAsync(
        Buffer.from(otherPrivateKey).toString('hex')
      );
      const otherLogger = new AuditLogger(makeConfig(), {
        privateKey: otherPrivateKey,
        publicKey: otherPublicKey,
        verificationMethod: 'did:key:z6MkOther#z6MkOther',
      });

      const history = await logger.getMigrationHistory(record.sourceDid);
      const verified = await otherLogger.verifyAuditRecord(history[0]);
      expect(verified).toBe(false);
    });
  });

  describe('record storage', () => {
    it('should store records by source and target DID', async () => {
      const logger = new AuditLogger(makeConfig());
      const record = makeAuditRecord();

      await logger.logMigration(record);

      const sourceHistory = await logger.getMigrationHistory(record.sourceDid);
      const targetHistory = await logger.getMigrationHistory(record.targetDid!);
      expect(sourceHistory).toHaveLength(1);
      expect(targetHistory).toHaveLength(1);
    });

    it('should not store by target DID if null', async () => {
      const logger = new AuditLogger(makeConfig());
      const record = makeAuditRecord({ targetDid: null });

      await logger.logMigration(record);

      const sourceHistory = await logger.getMigrationHistory(record.sourceDid);
      expect(sourceHistory).toHaveLength(1);
    });

    it('should return empty array for unknown DID', async () => {
      const logger = new AuditLogger(makeConfig());
      const history = await logger.getMigrationHistory('did:peer:unknown');
      expect(history).toHaveLength(0);
    });

    it('should return false for record without signature', async () => {
      const logger = new AuditLogger(makeConfig());
      const record = makeAuditRecord();
      const verified = await logger.verifyAuditRecord(record);
      expect(verified).toBe(false);
    });
  });

  describe('getSystemMigrationLogs', () => {
    it('should deduplicate records across DIDs', async () => {
      const logger = new AuditLogger(makeConfig());
      const record = makeAuditRecord();

      await logger.logMigration(record);

      const logs = await logger.getSystemMigrationLogs({});
      // Record stored under both source and target DID, but deduped
      expect(logs).toHaveLength(1);
    });

    it('should filter by provided fields', async () => {
      const logger = new AuditLogger(makeConfig());
      await logger.logMigration(makeAuditRecord({ migrationId: 'mig_a' }));
      await logger.logMigration(makeAuditRecord({ migrationId: 'mig_b', sourceDid: 'did:peer:other' }));

      const filtered = await logger.getSystemMigrationLogs({ migrationId: 'mig_a' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].migrationId).toBe('mig_a');
    });
  });
});
