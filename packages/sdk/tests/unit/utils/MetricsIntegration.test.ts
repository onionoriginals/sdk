import { describe, test, expect, beforeEach } from 'bun:test';
import { MetricsCollector } from '../../../src/utils/MetricsCollector';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { OriginalsSDK } from '../../../src/core/OriginalsSDK';
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
      credentialManager = new CredentialManager(testConfig, undefined, metrics);
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
      const cm = new CredentialManager(testConfig);
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

    test('should track createDIDPeer operation', async () => {
      const resources = [{
        id: 'main.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc123def456',
      }];

      const didDoc = await didManager.createDIDPeer(resources);
      expect(didDoc).toBeDefined();

      const opMetrics = metrics.getOperationMetrics('did.createDIDPeer');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
      expect(opMetrics!.totalTime).toBeGreaterThan(0);
    });

    test('should track migrateToDIDWebVH operation', async () => {
      const resources = [{
        id: 'main.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc123def456',
      }];

      const didDoc = await didManager.createDIDPeer(resources);
      const migrated = await didManager.migrateToDIDWebVH(didDoc);
      expect(migrated.id).toContain('did:webvh:');

      const opMetrics = metrics.getOperationMetrics('did.migrateToDIDWebVH');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
    });

    test('should track migrateToDIDBTCO operation', async () => {
      const resources = [{
        id: 'main.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc123def456',
      }];

      const didDoc = await didManager.createDIDPeer(resources);
      const migrated = await didManager.migrateToDIDBTCO(didDoc, '12345');
      expect(migrated.id).toContain('did:btco:');

      const opMetrics = metrics.getOperationMetrics('did.migrateToDIDBTCO');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
    });

    test('should track resolveDID operation', async () => {
      const resources = [{
        id: 'main.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc123def456',
      }];

      const didDoc = await didManager.createDIDPeer(resources);
      const resolved = await didManager.resolveDID(didDoc.id);
      expect(resolved).not.toBeNull();

      const opMetrics = metrics.getOperationMetrics('did.resolveDID');
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
    });

    test('should track failed operations with error count', async () => {
      try {
        await didManager.migrateToDIDBTCO(
          { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:test' },
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

  describe('OriginalsSDK shared metrics', () => {
    test('should share MetricsCollector across all managers', () => {
      const sdk = OriginalsSDK.create({
        network: 'regtest',
        defaultKeyType: 'Ed25519',
        webvhNetwork: 'magby',
      });

      // The SDK's metrics instance should be accessible
      expect(sdk.metrics).toBeDefined();
      expect(sdk.metrics).toBeInstanceOf(MetricsCollector);
    });

    test('should aggregate metrics from all managers', async () => {
      const sdk = OriginalsSDK.create({
        network: 'regtest',
        defaultKeyType: 'Ed25519',
        webvhNetwork: 'magby',
      });

      // Create an asset (goes through DIDManager and LifecycleManager)
      const asset = await sdk.lifecycle.createAsset([{
        id: 'test.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc123',
      }]);

      expect(asset).toBeDefined();

      // Check that metrics were recorded across managers
      const allMetrics = sdk.metrics.getMetrics();
      expect(allMetrics.assetsCreated).toBeGreaterThanOrEqual(1);

      // DIDManager should have tracked createDIDPeer
      const didMetrics = sdk.metrics.getOperationMetrics('did.createDIDPeer');
      expect(didMetrics).not.toBeNull();
      expect(didMetrics!.count).toBeGreaterThanOrEqual(1);

      // LifecycleManager should have tracked createAsset
      const lcMetrics = sdk.metrics.getOperationMetrics('lifecycle.createAsset');
      expect(lcMetrics).not.toBeNull();
      expect(lcMetrics!.count).toBeGreaterThanOrEqual(1);
    });

    test('should export aggregated Prometheus metrics', async () => {
      const sdk = OriginalsSDK.create({
        network: 'regtest',
        defaultKeyType: 'Ed25519',
        webvhNetwork: 'magby',
      });

      await sdk.lifecycle.createAsset([{
        id: 'test.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc123',
      }]);

      const prometheus = sdk.metrics.export('prometheus');

      // Should contain label-based operation metrics from multiple managers
      expect(prometheus).toContain('originals_assets_created_total');
      expect(prometheus).toContain('originals_operation_total{operation="did.createDIDPeer"}');
      expect(prometheus).toContain('originals_operation_total{operation="lifecycle.createAsset"}');
      expect(prometheus).toContain('originals_uptime_milliseconds');
    });
  });
});
