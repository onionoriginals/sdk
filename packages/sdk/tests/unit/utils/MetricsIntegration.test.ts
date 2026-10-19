import { describe, test, expect, beforeEach } from 'bun:test';
import { MetricsCollector } from '../../../src/utils/MetricsCollector';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { DIDManager } from '../../../src/did/DIDManager';
import type { OriginalsConfig } from '../../../src/types';

const testConfig: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
  webvhNetwork: 'magby',
};

describe('Metrics Integration', () => {
  describe('CredentialManager metrics tracking', () => {
    let metrics: MetricsCollector;
    let credentialManager: CredentialManager;

    beforeEach(() => {
      metrics = new MetricsCollector();
      credentialManager = new CredentialManager(testConfig, new DIDManager(testConfig as never), metrics);
    });

    test('should track credential signing operation', async () => {
      const credential = credentialManager.createResourceCredential(
        'ResourceCreated',
        { id: 'did:peer:test', resourceId: 'r1', resourceType: 'code' },
        'did:peer:issuer'
      );

      // Sign with a dummy key - will use legacy path
      try {
        await credentialManager.signCredential(credential, 'z' + 'a'.repeat(64), 'zVM123');
      } catch {
        // May fail due to key format, but metrics should still record
      }

      const opMetrics = metrics.getOperationMetrics('credential.sign');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
      expect(opMetrics!.totalTime).toBeGreaterThan(0);
    });

    test('should track credential verification operation', async () => {
      const credential = credentialManager.createResourceCredential(
        'ResourceCreated',
        { id: 'did:peer:test', resourceId: 'r1', resourceType: 'code' },
        'did:peer:issuer'
      );

      // Verify unsigned credential - should return false but track the operation
      const result = await credentialManager.verifyCredential(credential);
      expect(result).toBe(false);

      const opMetrics = metrics.getOperationMetrics('credential.verify');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
      expect(opMetrics!.errorCount).toBe(0); // returned false, not an error
    });

    test('should track computeCredentialHash operation', async () => {
      const credential = credentialManager.createResourceCredential(
        'ResourceCreated',
        { id: 'did:peer:test', resourceId: 'r1', resourceType: 'code' },
        'did:peer:issuer'
      );

      const hash = await credentialManager.computeCredentialHash(credential);
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');

      const opMetrics = metrics.getOperationMetrics('credential.computeHash');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
    });

    test('should work without metrics (backward compatible)', () => {
      const cm = new CredentialManager(testConfig, new DIDManager(testConfig as never));
      const credential = cm.createResourceCredential(
        'ResourceCreated',
        { id: 'did:peer:test', resourceId: 'r1', resourceType: 'code' },
        'did:peer:issuer'
      );
      expect(credential).toBeDefined();
    });
  });

  describe('DIDManager metrics tracking', () => {
    let metrics: MetricsCollector;
    let didManager: DIDManager;

    beforeEach(() => {
      metrics = new MetricsCollector();
      didManager = new DIDManager(testConfig, metrics);
    });

    test('should track migrateToDIDWebVH operation', async () => {
      const sourceDoc = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:vh:metrics-webvh' };
      const migrated = await didManager.migrateToDIDWebVH(sourceDoc, 'example.com');
      expect(migrated.didDocument.id).toContain('did:webvh:');

      const opMetrics = metrics.getOperationMetrics('did.migrateToDIDWebVH');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
    });

    test('should track migrateToDIDBTCO operation', async () => {
      const sourceDoc = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:vh:metrics-btco' };
      const migrated = await didManager.migrateToDIDBTCO(sourceDoc, '12345');
      expect(migrated.id).toContain('did:btco:');

      const opMetrics = metrics.getOperationMetrics('did.migrateToDIDBTCO');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
    });

    test('should track resolveDID operation', async () => {
      const { OrdMockProvider } = await import('../../../src/adapters/providers/OrdMockProvider');
      const sat = '710001';
      const did = `did:btco:${sat}`;
      const doc = { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
      const provider = new OrdMockProvider({
        inscriptionsById: new Map([[`insc-${sat}`, {
          inscriptionId: `insc-${sat}`,
          content: Buffer.from(JSON.stringify(doc), 'utf8'),
          contentType: 'application/json',
          txid: `tx-${sat}`,
          vout: 0,
          satoshi: sat,
        }]]),
        inscriptionsBySatoshi: new Map([[sat, [`insc-${sat}`]]]),
      });
      const dm = new DIDManager({ network: 'mainnet', defaultKeyType: 'Ed25519', ordinalsProvider: provider }, metrics);

      const resolved = await dm.resolveDID(did);
      expect(resolved).not.toBeNull();

      const opMetrics = metrics.getOperationMetrics('did.resolveDID');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
    });

    test('should track failed operations with error count', async () => {
      try {
        await didManager.migrateToDIDBTCO(
          { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:vh:test' },
          '-1'
        );
      } catch {
        // expected to fail
      }

      const opMetrics = metrics.getOperationMetrics('did.migrateToDIDBTCO');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.errorCount).toBe(1);
    });
  });
});
