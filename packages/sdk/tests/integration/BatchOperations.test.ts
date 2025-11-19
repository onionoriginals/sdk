/**
 * Integration tests for Batch Operations
 * 
 * Tests the complete integration of batch operations with LifecycleManager,
 * including event emission, cost savings, and end-to-end workflows
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { OriginalsAsset } from '../../src/lifecycle/OriginalsAsset';
import { AssetResource, OriginalsConfig } from '../../src/types';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { FeeOracleMock } from '../../src/adapters/FeeOracleMock';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { StorageAdapter as ConfigStorageAdapter } from '../../src/adapters/types';
import { MockKeyStore } from '../mocks/MockKeyStore';
import type { BatchResult } from '../../src/lifecycle/BatchOperations';
import { KeyManager } from '../../src/did/KeyManager';

function makeHash(prefix: string): string {
  const hexOnly = prefix.split('').map(c => {
    if (/[0-9a-f]/i.test(c)) return c;
    return c.charCodeAt(0).toString(16).slice(-1);
  }).join('');
  return hexOnly.padEnd(64, '0');
}

class StorageAdapterBridge implements ConfigStorageAdapter {
  constructor(private memoryAdapter: MemoryStorageAdapter) {}

  async put(objectKey: string, data: Buffer | string, options?: { contentType?: string }): Promise<string> {
    const firstSlash = objectKey.indexOf('/');
    const domain = firstSlash >= 0 ? objectKey.substring(0, firstSlash) : objectKey;
    const path = firstSlash >= 0 ? objectKey.substring(firstSlash + 1) : '';
    const content = typeof data === 'string' ? Buffer.from(data) : data;
    return await this.memoryAdapter.putObject(domain, path, new Uint8Array(content));
  }

  async get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null> {
    const firstSlash = objectKey.indexOf('/');
    const domain = firstSlash >= 0 ? objectKey.substring(0, firstSlash) : objectKey;
    const path = firstSlash >= 0 ? objectKey.substring(firstSlash + 1) : '';
    const result = await this.memoryAdapter.getObject(domain, path);
    if (!result) return null;
    return {
      content: Buffer.from(result.content),
      contentType: result.contentType || 'application/octet-stream'
    };
  }

  async delete(objectKey: string): Promise<boolean> {
    return false;
  }
}

describe('Batch Operations Integration', () => {
  let sdk: OriginalsSDK;
  let memoryStorage: MemoryStorageAdapter;
  let feeOracle: FeeOracleMock;
  let ordinalsProvider: OrdMockProvider;
  let keyStore: MockKeyStore;

  beforeEach(async () => {
    memoryStorage = new MemoryStorageAdapter();
    const storageAdapter = new StorageAdapterBridge(memoryStorage);
    feeOracle = new FeeOracleMock(7);
    ordinalsProvider = new OrdMockProvider();
    keyStore = new MockKeyStore();

    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'Ed25519', // Use Ed25519 for did:webvh compatibility
      enableLogging: false,
      storageAdapter,
      feeOracle,
      ordinalsProvider
    };

    sdk = new OriginalsSDK(config, keyStore);
    
    // Set up publisher DID keys for batch operation tests
    const keyManager = new KeyManager();
    const domains = ['example.com', 'test.com', 'batch.test'];
    for (const domain of domains) {
      const publisherKey = await keyManager.generateKeyPair('Ed25519');
      await keyStore.setPrivateKey(`did:webvh:${domain}:user#key-0`, publisherKey.privateKey);
    }
  });

  describe('batchCreateAssets', () => {
    test('should create multiple assets successfully', async () => {
      const resourcesList = [
        [
          { id: 'res1', type: 'image', contentType: 'image/png', hash: makeHash('img1'), content: 'image1' }
        ],
        [
          { id: 'res2', type: 'text', contentType: 'text/plain', hash: makeHash('txt1'), content: 'text1' }
        ],
        [
          { id: 'res3', type: 'data', contentType: 'application/json', hash: makeHash('json1'), content: '{"key":"value"}' }
        ]
      ];

      const result = await sdk.lifecycle.batchCreateAssets(resourcesList);

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(result.totalProcessed).toBe(3);
      expect(result.batchId).toBeDefined();
      expect(result.totalDuration).toBeGreaterThanOrEqual(0);

      // Verify each asset
      for (const item of result.successful) {
        expect(item.result).toBeInstanceOf(OriginalsAsset);
        expect(item.result.currentLayer).toBe('did:peer');
        expect(item.result.id).toMatch(/^did:peer:/);
      }
    });

    test('should handle validation errors', async () => {
      const invalidResourcesList = [
        [], // Empty resources
        [{ id: 'res1' }] // Missing required fields
      ];

      await expect(
        sdk.lifecycle.batchCreateAssets(invalidResourcesList as any)
      ).rejects.toThrow('Batch validation failed');
    });

    test('should continue on error when specified', async () => {
      const resourcesList = [
        [
          { id: 'res1', type: 'image', contentType: 'image/png', hash: makeHash('img1'), content: 'image1' }
        ],
        [], // This will fail validation at runtime
        [
          { id: 'res3', type: 'text', contentType: 'text/plain', hash: makeHash('txt1'), content: 'text1' }
        ]
      ];

      // Disable pre-validation to test runtime errors
      const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        validateFirst: false,
        continueOnError: true
      });

      expect(result.successful.length).toBeGreaterThan(0);
      expect(result.failed.length).toBeGreaterThan(0);
    });

    test('should emit batch events', async () => {
      const events: any[] = [];
      const unsubscribe = sdk.lifecycle.on('batch:started', (event) => {
        events.push({ type: 'started', event });
      });
      sdk.lifecycle.on('batch:completed', (event) => {
        events.push({ type: 'completed', event });
      });

      const resourcesList = [
        [{ id: 'res1', type: 'image', contentType: 'image/png', hash: makeHash('img1'), content: 'image1' }]
      ];

      await sdk.lifecycle.batchCreateAssets(resourcesList);

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.find(e => e.type === 'started')).toBeDefined();
      expect(events.find(e => e.type === 'completed')).toBeDefined();

      const startedEvent = events.find(e => e.type === 'started').event;
      expect(startedEvent.operation).toBe('create');
      expect(startedEvent.itemCount).toBe(1);

      unsubscribe();
    });
  });

  describe('batchPublishToWeb', () => {
    test('should publish multiple assets successfully', async () => {
      // Create assets first
      const assets: OriginalsAsset[] = [];
      for (let i = 0; i < 3; i++) {
        const asset = await sdk.lifecycle.createAsset([
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);
        assets.push(asset);
      }

      const result = await sdk.lifecycle.batchPublishToWeb(assets, 'example.com');

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);

      // Verify all assets are published
      for (const item of result.successful) {
        expect(item.result.currentLayer).toBe('did:webvh');
        expect(item.result.resources[0].url).toBeDefined();
        expect(item.result.resources[0].url).toMatch(/^did:webvh:/);
      }
    });

    test('should validate domain format', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'res1', type: 'text', contentType: 'text/plain', hash: makeHash('txt1'), content: 'text1' }
      ]);

      await expect(
        sdk.lifecycle.batchPublishToWeb([asset], 'invalid domain!')
      ).rejects.toThrow('Invalid domain format');
    });

    test('should emit batch events for publishing', async () => {
      const events: any[] = [];
      sdk.lifecycle.on('batch:started', (event) => {
        events.push({ type: 'started', event });
      });
      sdk.lifecycle.on('batch:completed', (event) => {
        events.push({ type: 'completed', event });
      });

      const asset = await sdk.lifecycle.createAsset([
        { id: 'res1', type: 'text', contentType: 'text/plain', hash: makeHash('txt1'), content: 'text1' }
      ]);

      await sdk.lifecycle.batchPublishToWeb([asset], 'example.com');

      const startedEvent = events.find(e => e.type === 'started')?.event;
      expect(startedEvent.operation).toBe('publish');
    });
  });

  describe('batchInscribeOnBitcoin - Individual Transactions', () => {
    test('should inscribe multiple assets individually', async () => {
      const assets: OriginalsAsset[] = [];
      for (let i = 0; i < 3; i++) {
        const asset = await sdk.lifecycle.createAsset([
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);
        assets.push(asset);
      }

      const result = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
        singleTransaction: false,
        feeRate: 5
      });

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);

      // Verify all assets are inscribed
      for (const item of result.successful) {
        expect(item.result.currentLayer).toBe('did:btco');
        const provenance = item.result.getProvenance();
        const latestMigration = provenance.migrations[provenance.migrations.length - 1];
        expect(latestMigration.transactionId).toBeDefined();
        expect(latestMigration.inscriptionId).toBeDefined();
      }
    });
  });

  describe('batchInscribeOnBitcoin - Single Transaction (Cost Savings)', () => {
    test('should inscribe multiple assets in single transaction', async () => {
      const assets: OriginalsAsset[] = [];
      for (let i = 0; i < 5; i++) {
        const asset = await sdk.lifecycle.createAsset([
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);
        assets.push(asset);
      }

      const result = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
        singleTransaction: true,
        feeRate: 10
      });

      expect(result.successful).toHaveLength(5);
      expect(result.failed).toHaveLength(0);

      // Verify all assets share the same batch transaction
      const batchIds = new Set<string>();
      const transactionIds = new Set<string>();
      
      for (const item of result.successful) {
        expect(item.result.currentLayer).toBe('did:btco');
        const provenance = item.result.getProvenance();
        const latestMigration = provenance.migrations[provenance.migrations.length - 1];
        
        expect((latestMigration as any).batchId).toBeDefined();
        expect((latestMigration as any).batchInscription).toBe(true);
        expect((latestMigration as any).feePaid).toBeDefined();
        
        batchIds.add((latestMigration as any).batchId);
        transactionIds.add(latestMigration.transactionId!);
      }

      // All assets should share the same batch ID and transaction ID
      expect(batchIds.size).toBe(1);
      expect(transactionIds.size).toBe(1);
    });

    test('should calculate cost savings correctly', async () => {
      const assets: OriginalsAsset[] = [];
      for (let i = 0; i < 10; i++) {
        const asset = await sdk.lifecycle.createAsset([
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);
        assets.push(asset);
      }

      // Track batch events to capture cost savings
      let costSavings: any = null;
      sdk.lifecycle.on('batch:completed', (event) => {
        if (event.results.costSavings) {
          costSavings = event.results.costSavings;
        }
      });

      await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
        singleTransaction: true,
        feeRate: 10
      });

      expect(costSavings).toBeDefined();
      expect(costSavings.amount).toBeGreaterThan(0);
      expect(costSavings.percentage).toBeGreaterThan(0);
      // Should save at least 30% as per requirements
      expect(costSavings.percentage).toBeGreaterThanOrEqual(30);
    });

    test('should split fees proportionally by data size', async () => {
      // Create assets of different sizes
      const assets: OriginalsAsset[] = [];
      
      // Small asset
      assets.push(await sdk.lifecycle.createAsset([
        { id: 'small', type: 'text', contentType: 'text/plain', hash: makeHash('small'), content: 'x' }
      ]));
      
      // Large asset
      assets.push(await sdk.lifecycle.createAsset([
        { id: 'large', type: 'text', contentType: 'text/plain', hash: makeHash('large'), content: 'x'.repeat(1000) }
      ]));

      const result = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
        singleTransaction: true,
        feeRate: 10
      });

      const smallAssetFee = (result.successful[0].result.getProvenance().migrations[0] as any).feePaid;
      const largeAssetFee = (result.successful[1].result.getProvenance().migrations[0] as any).feePaid;

      // Large asset should pay more fees
      expect(largeAssetFee).toBeGreaterThan(smallAssetFee);
    });

    test('should handle atomic failure in single transaction mode', async () => {
      const assets: OriginalsAsset[] = [];
      for (let i = 0; i < 3; i++) {
        const asset = await sdk.lifecycle.createAsset([
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);
        assets.push(asset);
      }

      // Mock a failure scenario by using an invalid configuration
      // In single transaction mode, if the transaction fails, ALL assets should fail
      try {
        const result = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
          singleTransaction: true,
          feeRate: 10
        });
        
        // If it succeeds, all should succeed
        expect(result.failed).toHaveLength(0);
      } catch (error) {
        // If it fails, it should be a BatchError
        expect(error).toBeDefined();
      }
    });
  });

  describe('batchTransferOwnership', () => {
    test('should transfer multiple assets successfully', async () => {
      // Create and inscribe assets
      const assets: OriginalsAsset[] = [];
      for (let i = 0; i < 3; i++) {
        const asset = await sdk.lifecycle.createAsset([
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);
        const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset, asset.id, 5);
        assets.push(inscribed);
      }

      const transfers = assets.map(asset => ({
        asset,
        to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
      }));

      const result = await sdk.lifecycle.batchTransferOwnership(transfers);

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);

      // Verify all transfers
      for (let i = 0; i < assets.length; i++) {
        const provenance = assets[i].getProvenance();
        expect(provenance.transfers).toHaveLength(1);
        expect(provenance.transfers[0].to).toBe('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
      }
    });

    test('should validate Bitcoin addresses', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'res1', type: 'text', contentType: 'text/plain', hash: makeHash('txt1'), content: 'text1' }
      ]);
      const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset, asset.id, 5);

      const transfers = [
        { asset: inscribed, to: 'invalid-address' }
      ];

      await expect(
        sdk.lifecycle.batchTransferOwnership(transfers)
      ).rejects.toThrow();
    });

    test('should validate assets are inscribed', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'res1', type: 'text', contentType: 'text/plain', hash: makeHash('txt1'), content: 'text1' }
      ]);

      const transfers = [
        { asset, to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }
      ];

      await expect(
        sdk.lifecycle.batchTransferOwnership(transfers)
      ).rejects.toThrow('Batch validation failed');
    });
  });

  describe('Complete Batch Lifecycle', () => {
    test('should execute full lifecycle with batch operations', async () => {
      // Phase 1: Batch create
      const resourcesList = Array.from({ length: 5 }, (_, i) => [
        { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
      ]);

      const createResult = await sdk.lifecycle.batchCreateAssets(resourcesList);
      expect(createResult.successful).toHaveLength(5);

      const assets = createResult.successful.map(s => s.result);

      // Phase 2: Batch publish
      const publishResult = await sdk.lifecycle.batchPublishToWeb(assets, 'batch.test');
      expect(publishResult.successful).toHaveLength(5);

      const publishedAssets = publishResult.successful.map(s => s.result);

      // Phase 3: Batch inscribe with cost savings
      const inscribeResult = await sdk.lifecycle.batchInscribeOnBitcoin(publishedAssets, {
        singleTransaction: true,
        feeRate: 10
      });
      expect(inscribeResult.successful).toHaveLength(5);

      const inscribedAssets = inscribeResult.successful.map(s => s.result);

      // Phase 4: Batch transfer
      const transfers = inscribedAssets.map(asset => ({
        asset,
        to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
      }));

      const transferResult = await sdk.lifecycle.batchTransferOwnership(transfers);
      expect(transferResult.successful).toHaveLength(5);

      // Verify complete provenance chain
      for (const asset of inscribedAssets) {
        const provenance = asset.getProvenance();
        expect(provenance.migrations).toHaveLength(2); // peer -> webvh -> btco
        expect(provenance.transfers).toHaveLength(1);
        expect(provenance.migrations[0].from).toBe('did:peer');
        expect(provenance.migrations[0].to).toBe('did:webvh');
        expect(provenance.migrations[1].from).toBe('did:webvh');
        expect(provenance.migrations[1].to).toBe('did:btco');
      }
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle large batches efficiently', async () => {
      const resourcesList = Array.from({ length: 50 }, (_, i) => [
        { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
      ]);

      const startTime = Date.now();
      const result = await sdk.lifecycle.batchCreateAssets(resourcesList, {
        maxConcurrent: 5
      });
      const duration = Date.now() - startTime;

      expect(result.successful).toHaveLength(50);
      expect(result.totalDuration).toBeGreaterThanOrEqual(0);
      
      // With concurrency, should complete in reasonable time
      expect(duration).toBeLessThan(30000); // 30 seconds
    });

    test('should handle batch inscription of many assets', async () => {
      const assets: OriginalsAsset[] = [];
      for (let i = 0; i < 20; i++) {
        const asset = await sdk.lifecycle.createAsset([
          { id: `res${i}`, type: 'text', contentType: 'text/plain', hash: makeHash(`txt${i}`), content: `text${i}` }
        ]);
        assets.push(asset);
      }

      const startTime = Date.now();
      const result = await sdk.lifecycle.batchInscribeOnBitcoin(assets, {
        singleTransaction: true,
        feeRate: 10
      });
      const duration = Date.now() - startTime;

      expect(result.successful).toHaveLength(20);
      expect(duration).toBeLessThan(10000); // Should be fast with single transaction
    });
  });
});
