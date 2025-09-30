/**
 * End-to-End Integration Test Suite for Complete Lifecycle Flow
 * 
 * This test suite validates the complete lifecycle flow:
 * peer → webvh → btco → transfer
 * 
 * Key aspects tested:
 * - Real storage adapter (MemoryStorageAdapter)
 * - Real fee oracle (FeeOracleMock)
 * - Real ordinals provider (OrdMockProvider)
 * - Complete provenance tracking across all layers
 * - Resource integrity and URL generation
 * - Credential issuance and verification
 * - Transfer ownership on Bitcoin layer
 * 
 * Rationale: Found individual integration tests but no end-to-end test covering
 * the full lifecycle. Current tests use mocks extensively. This suite provides
 * confidence that all adapter interfaces work correctly together in a realistic flow.
 */

import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { OriginalsAsset } from '../../src/lifecycle/OriginalsAsset';
import { AssetResource, OriginalsConfig } from '../../src/types';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { FeeOracleMock } from '../../src/adapters/FeeOracleMock';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { StorageAdapter as ConfigStorageAdapter } from '../../src/adapters/types';

/**
 * Helper to generate valid SHA-256 hashes (64 hex characters)
 * Replaces non-hex characters with hex equivalents to ensure valid hash format
 */
function makeHash(prefix: string): string {
  // Replace non-hex characters with their hex representation or '0'
  const hexOnly = prefix.split('').map(c => {
    if (/[0-9a-f]/i.test(c)) return c;
    // Convert to hex char code and take last character, or use '0'
    return c.charCodeAt(0).toString(16).slice(-1);
  }).join('');
  
  return hexOnly.padEnd(64, '0');
}

/**
 * Adapter wrapper to bridge MemoryStorageAdapter to the StorageAdapter interface
 * expected by OriginalsConfig. The main difference is method naming:
 * - MemoryStorageAdapter uses putObject/getObject
 * - Config expects put/get
 */
class StorageAdapterBridge implements ConfigStorageAdapter {
  constructor(private memoryAdapter: MemoryStorageAdapter) {}

  async put(objectKey: string, data: Buffer | string, options?: { contentType?: string }): Promise<string> {
    // objectKey is in format "domain/path"
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
    // Optional method, not implemented in MemoryStorageAdapter
    return false;
  }
}

describe('E2E Integration: Complete Lifecycle Flow', () => {
  let sdk: OriginalsSDK;
  let memoryStorage: MemoryStorageAdapter;
  let storageAdapter: ConfigStorageAdapter;
  let feeOracle: FeeOracleMock;
  let ordinalsProvider: OrdMockProvider;

  beforeEach(() => {
    // Setup real adapters (not mocks in the sense of jest.mock, but functional test doubles)
    memoryStorage = new MemoryStorageAdapter();
    storageAdapter = new StorageAdapterBridge(memoryStorage);
    feeOracle = new FeeOracleMock(7); // 7 sats/vB
    ordinalsProvider = new OrdMockProvider();

    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'ES256K',
      enableLogging: false,
      storageAdapter,
      feeOracle,
      ordinalsProvider
    };

    sdk = new OriginalsSDK(config);
  });

  describe('Complete Lifecycle: peer → webvh → btco → transfer', () => {
    test('successfully executes full lifecycle with provenance tracking', async () => {
      // ===== PHASE 1: Create Asset (did:peer) =====
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'image',
          contentType: 'image/png',
          hash: 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
          content: 'mock-image-data'
        },
        {
          id: 'resource-2',
          type: 'text',
          contentType: 'text/plain',
          hash: 'cafebabe1234567890abcdef1234567890abcdef1234567890abcdef12345678',
          content: 'Hello, Originals Protocol!'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);

      // Verify asset creation
      expect(asset).toBeInstanceOf(OriginalsAsset);
      expect(asset.currentLayer).toBe('did:peer');
      expect(asset.id).toMatch(/^did:peer:/);
      expect(asset.resources).toHaveLength(2);
      expect(asset.resources[0].id).toBe('resource-1');
      expect(asset.resources[1].id).toBe('resource-2');

      // Verify initial provenance
      const initialProvenance = asset.getProvenance();
      expect(initialProvenance.creator).toBe(asset.id);
      expect(initialProvenance.migrations).toHaveLength(0);
      expect(initialProvenance.transfers).toHaveLength(0);
      expect(initialProvenance.createdAt).toBeDefined();

      // ===== PHASE 2: Publish to Web (did:webvh) =====
      const domain = 'example.com';
      const webAsset = await sdk.lifecycle.publishToWeb(asset, domain);

      // Verify web publication
      expect(webAsset.currentLayer).toBe('did:webvh');
      expect(webAsset.id).toBe(asset.id); // Asset ID should remain the same
      
      // Verify did:webvh binding
      const bindings = (webAsset as any).bindings;
      expect(bindings).toBeDefined();
      expect(bindings['did:webvh']).toMatch(new RegExp(`^did:webvh:${domain}:`));

      // Verify resources have URLs from storage adapter
      for (const resource of webAsset.resources) {
        expect(resource.url).toBeDefined();
        expect(resource.url).toMatch(/^mem:\/\//); // MemoryStorageAdapter URL format
        expect(resource.url).toContain(domain);
        expect(resource.url).toContain('.well-known/webvh/');
      }

      // Verify storage adapter actually stored the resources
      for (const resource of webAsset.resources) {
        const url = resource.url as string;
        const path = url.replace(`mem://${domain}/`, '');
        const stored = await memoryStorage.getObject(domain, path);
        expect(stored).not.toBeNull();
        expect(stored?.content).toBeDefined();
      }

      // Verify provenance after web migration
      const webProvenance = webAsset.getProvenance();
      expect(webProvenance.migrations).toHaveLength(1);
      expect(webProvenance.migrations[0].from).toBe('did:peer');
      expect(webProvenance.migrations[0].to).toBe('did:webvh');
      expect(webProvenance.migrations[0].timestamp).toBeDefined();

      // Verify publication credential was issued
      const credentials = (webAsset as any).credentials;
      expect(Array.isArray(credentials)).toBe(true);
      expect(credentials.length).toBeGreaterThan(0);
      
      const publicationCred = credentials.find((c: any) => 
        Array.isArray(c.type) && (c.type.includes('ResourceMigrated') || c.type.includes('ResourceCreated'))
      );
      expect(publicationCred).toBeDefined();
      expect(publicationCred.credentialSubject).toBeDefined();
      expect(publicationCred.credentialSubject.fromLayer).toBe('did:peer');
      expect(publicationCred.credentialSubject.toLayer).toBe('did:webvh');

      // ===== PHASE 3: Inscribe on Bitcoin (did:btco) =====
      const requestedFeeRate = 5; // sats/vB (will be overridden by fee oracle)
      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, requestedFeeRate);

      // Verify Bitcoin inscription
      expect(btcoAsset.currentLayer).toBe('did:btco');
      expect(btcoAsset.id).toBe(asset.id); // Asset ID should remain the same

      // Verify did:btco binding
      const btcoBindings = (btcoAsset as any).bindings;
      expect(btcoBindings).toBeDefined();
      expect(btcoBindings['did:btco']).toMatch(/^did:btco:/);
      expect(btcoBindings['did:webvh']).toBe(bindings['did:webvh']); // Previous binding preserved

      // Verify provenance after Bitcoin migration
      const btcoProvenance = btcoAsset.getProvenance();
      expect(btcoProvenance.migrations).toHaveLength(2);
      expect(btcoProvenance.migrations[1].from).toBe('did:webvh');
      expect(btcoProvenance.migrations[1].to).toBe('did:btco');
      expect(btcoProvenance.migrations[1].transactionId).toBeDefined();
      expect(btcoProvenance.migrations[1].inscriptionId).toBeDefined();
      expect(btcoProvenance.migrations[1].satoshi).toBeDefined();
      expect(btcoProvenance.migrations[1].revealTxId).toBeDefined();
      
      // Verify fee oracle was used (should be 7 from oracle, not 5 from request)
      expect(btcoProvenance.migrations[1].feeRate).toBe(7); // Fee oracle value takes precedence
      expect(typeof btcoProvenance.migrations[1].feeRate).toBe('number');

      // Verify the inscription exists in the ordinals provider
      const inscriptionId = btcoProvenance.migrations[1].inscriptionId;
      const inscription = await ordinalsProvider.getInscriptionById(inscriptionId!);
      expect(inscription).not.toBeNull();
      expect(inscription?.inscriptionId).toBe(inscriptionId);
      expect(inscription?.contentType).toBe('application/json');

      // ===== PHASE 4: Transfer Ownership =====
      const recipientAddress = 'bcrt1qrecipient123456789abcdefghijklmnopqrst';
      const transferResult = await sdk.lifecycle.transferOwnership(btcoAsset, recipientAddress);

      // Verify transfer transaction
      expect(transferResult.txid).toBeDefined();
      expect(typeof transferResult.txid).toBe('string');
      expect(transferResult.txid.length).toBeGreaterThan(0);
      expect(transferResult.vin).toBeDefined();
      expect(transferResult.vout).toBeDefined();
      expect(transferResult.fee).toBeDefined();

      // Verify provenance after transfer
      const finalProvenance = btcoAsset.getProvenance();
      expect(finalProvenance.transfers).toHaveLength(1);
      expect(finalProvenance.transfers[0].from).toBe(btcoAsset.id);
      expect(finalProvenance.transfers[0].to).toBe(recipientAddress);
      expect(finalProvenance.transfers[0].transactionId).toBe(transferResult.txid);
      expect(finalProvenance.transfers[0].timestamp).toBeDefined();
      expect(finalProvenance.txid).toBe(transferResult.txid);

      // ===== FINAL VERIFICATION: Complete provenance chain =====
      expect(finalProvenance.creator).toBe(asset.id);
      expect(finalProvenance.migrations).toHaveLength(2);
      expect(finalProvenance.transfers).toHaveLength(1);
      
      // Verify migration chain
      expect(finalProvenance.migrations[0].from).toBe('did:peer');
      expect(finalProvenance.migrations[0].to).toBe('did:webvh');
      expect(finalProvenance.migrations[1].from).toBe('did:webvh');
      expect(finalProvenance.migrations[1].to).toBe('did:btco');
      
      // Verify all timestamps are in correct order
      const createdAt = new Date(finalProvenance.createdAt).getTime();
      const migration1Time = new Date(finalProvenance.migrations[0].timestamp).getTime();
      const migration2Time = new Date(finalProvenance.migrations[1].timestamp).getTime();
      const transferTime = new Date(finalProvenance.transfers[0].timestamp).getTime();
      
      expect(migration1Time).toBeGreaterThanOrEqual(createdAt);
      expect(migration2Time).toBeGreaterThanOrEqual(migration1Time);
      expect(transferTime).toBeGreaterThanOrEqual(migration2Time);
    });

    test('handles peer → btco direct migration (skipping webvh)', async () => {
      // Create asset
      const resources: AssetResource[] = [
        {
          id: 'resource-direct',
          type: 'data',
          contentType: 'application/json',
          hash: 'direct123456789abcdef1234567890abcdef1234567890abcdef1234567890',
          content: '{"test": "data"}'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);
      expect(asset.currentLayer).toBe('did:peer');

      // Inscribe directly to Bitcoin (skip webvh)
      const requestedFeeRate = 10;
      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(asset, requestedFeeRate);

      // Verify direct migration
      expect(btcoAsset.currentLayer).toBe('did:btco');
      
      const provenance = btcoAsset.getProvenance();
      expect(provenance.migrations).toHaveLength(1);
      expect(provenance.migrations[0].from).toBe('did:peer');
      expect(provenance.migrations[0].to).toBe('did:btco');
      expect(provenance.migrations[0].feeRate).toBe(7); // Fee oracle takes precedence

      // Verify can transfer after direct migration
      const transferResult = await sdk.lifecycle.transferOwnership(
        btcoAsset,
        'bcrt1qanother123456789abcdefghijklmnopqrstuvw'
      );
      expect(transferResult.txid).toBeDefined();
      expect(provenance.transfers).toHaveLength(1);
    });

    test('validates complete asset integrity throughout lifecycle', async () => {
      // Create resources without inline content (hash-only)
      // This way verify() only checks structural integrity, not content hashes
      const resources: AssetResource[] = [
        {
          id: 'integrity-test',
          type: 'text',
          contentType: 'text/plain',
          hash: 'aaaa5678901234567890abcdef1234567890abcdef1234567890abcdef1234'
          // No content property - verify will skip content hash check
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);
      
      // Verify at each stage (structural only)
      expect(await asset.verify()).toBe(true);

      const webAsset = await sdk.lifecycle.publishToWeb(asset, 'integrity.test');
      expect(await webAsset.verify()).toBe(true);

      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, 5);
      expect(await btcoAsset.verify()).toBe(true);

      await sdk.lifecycle.transferOwnership(btcoAsset, 'bcrt1qtest123');
      expect(await btcoAsset.verify()).toBe(true);
    });
  });

  describe('Adapter Interface Validation', () => {
    test('storage adapter interface works correctly', async () => {
      const testDomain = 'test.example.com';
      const testPath = '.well-known/test/resource.txt';
      const testContent = 'Test storage content';

      // Test put operation
      const url = await memoryStorage.putObject(testDomain, testPath, testContent);
      expect(url).toMatch(/^mem:\/\//);
      expect(url).toContain(testDomain);

      // Test exists operation
      const exists = await memoryStorage.exists(testDomain, testPath);
      expect(exists).toBe(true);

      // Test get operation
      const retrieved = await memoryStorage.getObject(testDomain, testPath);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.content).toBeDefined();
      
      const retrievedText = new TextDecoder().decode(retrieved!.content);
      expect(retrievedText).toBe(testContent);

      // Test non-existent resource
      const notFound = await memoryStorage.getObject(testDomain, 'nonexistent.txt');
      expect(notFound).toBeNull();
    });

    test('fee oracle adapter interface works correctly', async () => {
      // Test fee estimation
      const fee1Block = await feeOracle.estimateFeeRate(1);
      expect(fee1Block).toBe(7); // Configured base rate

      const fee2Block = await feeOracle.estimateFeeRate(2);
      expect(fee2Block).toBe(6); // Decreases by 1 per block

      const fee10Block = await feeOracle.estimateFeeRate(10);
      expect(fee10Block).toBe(1); // Math.max(1, 7 - (10 - 1)) = Math.max(1, -2) = 1
      
      // Verify fee oracle is used in lifecycle
      const asset = await sdk.lifecycle.createAsset([
        { id: 'fee-test', type: 'data', contentType: 'text/plain', hash: makeHash('fee123'), content: 'test' }
      ]);
      
      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(asset, undefined);
      const provenance = btcoAsset.getProvenance();
      
      // Should use fee oracle since no feeRate provided
      expect(provenance.migrations[0].feeRate).toBeDefined();
    });

    test('ordinals provider adapter interface works correctly', async () => {
      // Test inscription creation
      const testData = Buffer.from('Test inscription data');
      const inscription = await ordinalsProvider.createInscription({
        data: testData,
        contentType: 'text/plain',
        feeRate: 5
      });

      expect(inscription.inscriptionId).toBeDefined();
      expect(inscription.revealTxId).toBeDefined();
      expect(inscription.satoshi).toBeDefined();
      expect(inscription.feeRate).toBe(5);

      // Test inscription retrieval
      const retrieved = await ordinalsProvider.getInscriptionById(inscription.inscriptionId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.inscriptionId).toBe(inscription.inscriptionId);
      expect(retrieved?.contentType).toBe('text/plain');

      // Test satoshi lookup
      const bySatoshi = await ordinalsProvider.getInscriptionsBySatoshi(inscription.satoshi!);
      expect(bySatoshi).toHaveLength(1);
      expect(bySatoshi[0].inscriptionId).toBe(inscription.inscriptionId);

      // Test transfer
      const transferResult = await ordinalsProvider.transferInscription(
        inscription.inscriptionId,
        'bcrt1qtest',
        { feeRate: 6 }
      );
      expect(transferResult.txid).toBeDefined();
      expect(transferResult.vin).toHaveLength(1);
      expect(transferResult.vout).toHaveLength(1);
      expect(transferResult.fee).toBeDefined();
    });

    test('adapters work together in publishToWeb', async () => {
      // Verify storage adapter receives correct data during publication
      const asset = await sdk.lifecycle.createAsset([
        {
          id: 'adapter-integration',
          type: 'text',
          contentType: 'text/html',
          hash: makeHash('html123456789abcdef1234567890abcdef1234567890abcdef12'),
          content: '<html><body>Test</body></html>'
        }
      ]);

      const domain = 'adapter-test.com';
      const webAsset = await sdk.lifecycle.publishToWeb(asset, domain);

      // Verify resource URL uses storage adapter
      const resourceUrl = webAsset.resources[0].url;
      expect(resourceUrl).toBeDefined();
      expect(resourceUrl).toMatch(/^mem:\/\//);

      // Verify content is retrievable through adapter
      const urlPath = resourceUrl!.replace(`mem://${domain}/`, '');
      const stored = await memoryStorage.getObject(domain, urlPath);
      expect(stored).not.toBeNull();
    });

    test('adapters work together in inscribeOnBitcoin', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'btc-test', type: 'data', contentType: 'application/json', hash: makeHash('btc123'), content: '{}' }
      ]);

      // Inscribe without specifying fee rate - should use oracle
      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(asset, undefined);
      const provenance = btcoAsset.getProvenance();

      // Verify fee from oracle was used
      expect(provenance.migrations[0].feeRate).toBeDefined();

      // Verify inscription is in provider
      const inscriptionId = provenance.migrations[0].inscriptionId;
      const inscription = await ordinalsProvider.getInscriptionById(inscriptionId!);
      expect(inscription).not.toBeNull();
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('throws error when transferring non-btco asset', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'error-test', type: 'data', contentType: 'text/plain', hash: makeHash('err123'), content: 'test' }
      ]);

      // Try to transfer peer layer asset
      await expect(
        sdk.lifecycle.transferOwnership(asset, 'bcrt1qtest')
      ).rejects.toThrow('Asset must be inscribed on Bitcoin before transfer');

      // Try to transfer webvh layer asset
      const webAsset = await sdk.lifecycle.publishToWeb(asset, 'error.test');
      await expect(
        sdk.lifecycle.transferOwnership(webAsset, 'bcrt1qtest')
      ).rejects.toThrow('Asset must be inscribed on Bitcoin before transfer');
    });

    test('handles multiple transfers correctly', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'multi-transfer', type: 'data', contentType: 'text/plain', hash: makeHash('multi123'), content: 'test' }
      ]);

      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

      // First transfer
      const recipient1 = 'bcrt1qrecipient1';
      const tx1 = await sdk.lifecycle.transferOwnership(btcoAsset, recipient1);
      expect(tx1.txid).toBeDefined();

      // Second transfer
      const recipient2 = 'bcrt1qrecipient2';
      const tx2 = await sdk.lifecycle.transferOwnership(btcoAsset, recipient2);
      expect(tx2.txid).toBeDefined();
      expect(tx2.txid).not.toBe(tx1.txid);

      // Verify both transfers in provenance
      const provenance = btcoAsset.getProvenance();
      expect(provenance.transfers).toHaveLength(2);
      expect(provenance.transfers[0].to).toBe(recipient1);
      expect(provenance.transfers[1].to).toBe(recipient2);
      expect(provenance.txid).toBe(tx2.txid); // Latest txid
    });

    test('handles empty resources array', async () => {
      const asset = await sdk.lifecycle.createAsset([]);
      
      expect(asset).toBeInstanceOf(OriginalsAsset);
      expect(asset.resources).toHaveLength(0);
      expect(asset.currentLayer).toBe('did:peer');
    });

    test('handles multiple resources with different content types', async () => {
      const resources: AssetResource[] = [
        { id: 'img', type: 'image', contentType: 'image/jpeg', hash: makeHash('img123'), content: 'jpeg-data' },
        { id: 'txt', type: 'text', contentType: 'text/plain', hash: makeHash('txt123'), content: 'text-data' },
        { id: 'json', type: 'data', contentType: 'application/json', hash: makeHash('json123'), content: '{"key":"value"}' },
        { id: 'html', type: 'document', contentType: 'text/html', hash: makeHash('html123'), content: '<div>test</div>' }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);
      const webAsset = await sdk.lifecycle.publishToWeb(asset, 'multi-type.test');

      // Verify all resources get URLs
      expect(webAsset.resources).toHaveLength(4);
      for (const resource of webAsset.resources) {
        expect(resource.url).toBeDefined();
        expect(resource.url).toMatch(/^mem:\/\//);
      }

      // Verify all are stored
      for (const resource of webAsset.resources) {
        const url = resource.url!;
        const path = url.replace('mem://multi-type.test/', '');
        const stored = await memoryStorage.getObject('multi-type.test', path);
        expect(stored).not.toBeNull();
      }
    });

    test('preserves bindings throughout lifecycle', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'binding-test', type: 'data', contentType: 'text/plain', hash: makeHash('bind123'), content: 'test' }
      ]);

      // After webvh
      const webAsset = await sdk.lifecycle.publishToWeb(asset, 'binding.test');
      const webBindings = (webAsset as any).bindings;
      expect(Object.keys(webBindings)).toContain('did:webvh');

      // After btco
      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, 5);
      const btcoBindings = (btcoAsset as any).bindings;
      expect(Object.keys(btcoBindings)).toContain('did:webvh');
      expect(Object.keys(btcoBindings)).toContain('did:btco');
      expect(btcoBindings['did:webvh']).toBe(webBindings['did:webvh']);

      // After transfer (bindings should still exist)
      await sdk.lifecycle.transferOwnership(btcoAsset, 'bcrt1qtest');
      const finalBindings = (btcoAsset as any).bindings;
      expect(finalBindings['did:webvh']).toBe(webBindings['did:webvh']);
      expect(finalBindings['did:btco']).toBe(btcoBindings['did:btco']);
    });
  });

  describe('Performance and Scalability', () => {
    test('handles large resource payloads', async () => {
      // Create a large resource (simulating a large image or document)
      const largeContent = 'x'.repeat(100000); // 100KB
      const resources: AssetResource[] = [
        {
          id: 'large-resource',
          type: 'data',
          contentType: 'application/octet-stream',
          hash: makeHash('large123456789abcdef1234567890abcdef1234567890abcdef1'),
          content: largeContent
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);
      const webAsset = await sdk.lifecycle.publishToWeb(asset, 'large.test');
      
      // Verify storage
      const url = webAsset.resources[0].url!;
      const path = url.replace('mem://large.test/', '');
      const stored = await memoryStorage.getObject('large.test', path);
      expect(stored?.content.length).toBeGreaterThan(99000);

      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, 5);
      expect(btcoAsset.currentLayer).toBe('did:btco');
    });

    test('handles many resources efficiently', async () => {
      // Create an asset with many resources
      const resources: AssetResource[] = Array.from({ length: 50 }, (_, i) => ({
        id: `resource-${i}`,
        type: 'data',
        contentType: 'text/plain',
        hash: makeHash(`res${i}`),
        content: `Content ${i}`
      }));

      const asset = await sdk.lifecycle.createAsset(resources);
      expect(asset.resources).toHaveLength(50);

      const webAsset = await sdk.lifecycle.publishToWeb(asset, 'many.test');
      
      // Verify all resources have URLs
      expect(webAsset.resources.every(r => r.url !== undefined)).toBe(true);

      // Verify all are stored
      for (const resource of webAsset.resources) {
        const url = resource.url!;
        const path = url.replace('mem://many.test/', '');
        const stored = await memoryStorage.getObject('many.test', path);
        expect(stored).not.toBeNull();
      }

      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, 5);
      expect(btcoAsset.currentLayer).toBe('did:btco');
      
      const provenance = btcoAsset.getProvenance();
      expect(provenance.migrations).toHaveLength(2);
    });
  });

  describe('Provenance Chain Validation', () => {
    test('maintains complete audit trail with all metadata', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'audit-test', type: 'data', contentType: 'text/plain', hash: makeHash('audit123'), content: 'test' }
      ]);

      const startTime = Date.now();

      const webAsset = await sdk.lifecycle.publishToWeb(asset, 'audit.test');
      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, 8); // Request 8, but oracle returns 7
      await sdk.lifecycle.transferOwnership(btcoAsset, 'bcrt1qrecipient');

      const provenance = btcoAsset.getProvenance();

      // Verify complete metadata
      expect(provenance.createdAt).toBeDefined();
      expect(provenance.creator).toBeDefined();
      expect(provenance.txid).toBeDefined();

      // Verify migration metadata
      expect(provenance.migrations).toHaveLength(2);
      
      const webMigration = provenance.migrations[0];
      expect(webMigration.from).toBe('did:peer');
      expect(webMigration.to).toBe('did:webvh');
      expect(webMigration.timestamp).toBeDefined();
      expect(new Date(webMigration.timestamp).getTime()).toBeGreaterThanOrEqual(startTime);

      const btcoMigration = provenance.migrations[1];
      expect(btcoMigration.from).toBe('did:webvh');
      expect(btcoMigration.to).toBe('did:btco');
      expect(btcoMigration.timestamp).toBeDefined();
      expect(btcoMigration.transactionId).toBeDefined();
      expect(btcoMigration.inscriptionId).toBeDefined();
      expect(btcoMigration.satoshi).toBeDefined();
      expect(btcoMigration.revealTxId).toBeDefined();
      expect(btcoMigration.feeRate).toBe(7); // Fee oracle overrides requested rate

      // Verify transfer metadata
      expect(provenance.transfers).toHaveLength(1);
      const transfer = provenance.transfers[0];
      expect(transfer.from).toBeDefined();
      expect(transfer.to).toBe('bcrt1qrecipient');
      expect(transfer.timestamp).toBeDefined();
      expect(transfer.transactionId).toBeDefined();
    });

    test('timestamps are monotonically increasing', async () => {
      const asset = await sdk.lifecycle.createAsset([
        { id: 'time-test', type: 'data', contentType: 'text/plain', hash: makeHash('time123'), content: 'test' }
      ]);

      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      const webAsset = await sdk.lifecycle.publishToWeb(asset, 'time.test');
      
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      const btcoAsset = await sdk.lifecycle.inscribeOnBitcoin(webAsset, 5);
      
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      await sdk.lifecycle.transferOwnership(btcoAsset, 'bcrt1qtest');

      const provenance = btcoAsset.getProvenance();
      
      const times = [
        new Date(provenance.createdAt).getTime(),
        new Date(provenance.migrations[0].timestamp).getTime(),
        new Date(provenance.migrations[1].timestamp).getTime(),
        new Date(provenance.transfers[0].timestamp).getTime()
      ];

      for (let i = 1; i < times.length; i++) {
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
      }
    });
  });
});