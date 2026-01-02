import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, LifecycleManager, type LifecycleProgress, type CostEstimate, type MigrationValidation } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';

const resources = [
  {
    id: 'res1',
    type: 'text',
    content: 'hello world',
    contentType: 'text/plain',
    hash: 'deadbeef'
  }
];

describe('LifecycleManager - Clean API', () => {
  describe('createDraft', () => {
    test('creates a peer-layer asset', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const asset = await sdk.lifecycle.createDraft(resources);
      expect(asset.currentLayer).toBe('did:peer');
      expect(asset.id.startsWith('did:peer:')).toBe(true);
    });

    test('reports progress during creation', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const progressEvents: LifecycleProgress[] = [];
      
      const asset = await sdk.lifecycle.createDraft(resources, {
        onProgress: (p) => progressEvents.push({ ...p })
      });
      
      expect(asset.currentLayer).toBe('did:peer');
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[0].phase).toBe('preparing');
      expect(progressEvents[progressEvents.length - 1].phase).toBe('complete');
      expect(progressEvents[progressEvents.length - 1].percentage).toBe(100);
    });

    test('reports failure progress on error', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const progressEvents: LifecycleProgress[] = [];
      
      // Pass invalid resources to trigger error
      await expect(
        sdk.lifecycle.createDraft([], {
          onProgress: (p) => progressEvents.push({ ...p })
        })
      ).rejects.toThrow();
      
      // Should have a failed progress event
      const failedEvent = progressEvents.find(p => p.phase === 'failed');
      expect(failedEvent).toBeDefined();
    });
  });

  describe('publish', () => {
    test('migrates asset to webvh layer', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      const published = await sdk.lifecycle.publish(draft, 'example.com');
      
      expect(published.currentLayer).toBe('did:webvh');
      expect(published.bindings?.['did:webvh']).toContain('example.com');
    });

    test('reports progress during publish', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      const progressEvents: LifecycleProgress[] = [];
      
      await sdk.lifecycle.publish(draft, 'example.com', {
        onProgress: (p) => progressEvents.push({ ...p })
      });
      
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[progressEvents.length - 1].phase).toBe('complete');
    });

    test('validates before publishing', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      // Migrate to webvh first (can't publish from webvh)
      await sdk.lifecycle.publish(draft, 'example.com');
      
      // Try to publish again - should fail validation
      await expect(
        sdk.lifecycle.publish(draft, 'other.com')
      ).rejects.toThrow(/validation failed/i);
    });
  });

  describe('inscribe', () => {
    test('inscribes asset on Bitcoin', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ 
        network: 'regtest', 
        ordinalsProvider: provider 
      } as any);
      
      const draft = await sdk.lifecycle.createDraft(resources);
      await sdk.lifecycle.publish(draft, 'example.com');
      const inscribed = await sdk.lifecycle.inscribe(draft, { feeRate: 10 });
      
      expect(inscribed.currentLayer).toBe('did:btco');
    });

    test('reports progress during inscription', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ 
        network: 'regtest', 
        ordinalsProvider: provider 
      } as any);
      
      const draft = await sdk.lifecycle.createDraft(resources);
      await sdk.lifecycle.publish(draft, 'example.com');
      const progressEvents: LifecycleProgress[] = [];
      
      await sdk.lifecycle.inscribe(draft, {
        feeRate: 10,
        onProgress: (p) => progressEvents.push({ ...p })
      });
      
      expect(progressEvents.length).toBeGreaterThan(0);
      // Should include cost estimate in messages
      const preparingEvent = progressEvents.find(p => 
        p.phase === 'preparing' && p.message.includes('sats')
      );
      expect(preparingEvent).toBeDefined();
    });

    test('fails validation without ordinals provider', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      await sdk.lifecycle.publish(draft, 'example.com');
      
      await expect(
        sdk.lifecycle.inscribe(draft)
      ).rejects.toThrow(/ordinalsProvider/i);
    });
  });

  describe('transfer', () => {
    test('transfers inscribed asset', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ 
        network: 'regtest', 
        ordinalsProvider: provider 
      } as any);
      
      const draft = await sdk.lifecycle.createDraft(resources);
      await sdk.lifecycle.publish(draft, 'example.com');
      await sdk.lifecycle.inscribe(draft, { feeRate: 10 });
      
      const tx = await sdk.lifecycle.transfer(
        draft, 
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
      );
      
      expect(tx.txid).toBeDefined();
    });

    test('reports progress during transfer', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ 
        network: 'regtest', 
        ordinalsProvider: provider 
      } as any);
      
      const draft = await sdk.lifecycle.createDraft(resources);
      await sdk.lifecycle.publish(draft, 'example.com');
      await sdk.lifecycle.inscribe(draft, { feeRate: 10 });
      
      const progressEvents: LifecycleProgress[] = [];
      
      await sdk.lifecycle.transfer(
        draft, 
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
        { onProgress: (p) => progressEvents.push({ ...p }) }
      );
      
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[progressEvents.length - 1].details?.transactionId).toBeDefined();
    });

    test('fails if asset not inscribed', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      await expect(
        sdk.lifecycle.transfer(draft, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
      ).rejects.toThrow(/must be inscribed/i);
    });
  });
});

describe('LifecycleManager - Cost Estimation', () => {
  describe('estimateCost', () => {
    test('returns zero cost for webvh migration', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const cost = await sdk.lifecycle.estimateCost(draft, 'did:webvh');
      
      expect(cost.totalSats).toBe(0);
      expect(cost.targetLayer).toBe('did:webvh');
      expect(cost.confidence).toBe('high');
    });

    test('estimates btco inscription cost', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const cost = await sdk.lifecycle.estimateCost(draft, 'did:btco', 10);
      
      expect(cost.totalSats).toBeGreaterThan(0);
      expect(cost.feeRate).toBe(10);
      expect(cost.targetLayer).toBe('did:btco');
      expect(cost.breakdown.networkFee).toBeGreaterThan(0);
      expect(cost.breakdown.dustValue).toBe(546);
      expect(cost.dataSize).toBeGreaterThan(0);
    });

    test('uses fee oracle when available', async () => {
      const mockFeeOracle = {
        estimateFeeRate: async (blocks: number) => 15
      };
      const sdk = OriginalsSDK.create({ 
        network: 'regtest',
        feeOracle: mockFeeOracle as any
      });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const cost = await sdk.lifecycle.estimateCost(draft, 'did:btco');
      
      expect(cost.feeRate).toBe(15);
      expect(cost.confidence).toBe('high');
    });

    test('uses ordinals provider when fee oracle unavailable', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ 
        network: 'regtest',
        ordinalsProvider: provider
      } as any);
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const cost = await sdk.lifecycle.estimateCost(draft, 'did:btco');
      
      expect(cost.feeRate).toBeGreaterThan(0);
      expect(cost.confidence).toBe('medium');
    });

    test('falls back to default fee rate', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const cost = await sdk.lifecycle.estimateCost(draft, 'did:btco');
      
      expect(cost.feeRate).toBe(10); // Default
      expect(cost.confidence).toBe('low');
    });

    test('returns zero for peer layer (no migration needed)', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const cost = await sdk.lifecycle.estimateCost(draft, 'did:peer');
      
      expect(cost.totalSats).toBe(0);
      expect(cost.confidence).toBe('high');
    });
  });
});

describe('LifecycleManager - Migration Validation', () => {
  describe('validateMigration', () => {
    test('validates peer to webvh migration', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const validation = await sdk.lifecycle.validateMigration(draft, 'did:webvh');
      
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
      expect(validation.currentLayer).toBe('did:peer');
      expect(validation.targetLayer).toBe('did:webvh');
      expect(validation.checks.layerTransition).toBe(true);
      expect(validation.checks.resourcesValid).toBe(true);
      expect(validation.checks.didDocumentValid).toBe(true);
    });

    test('validates peer to btco migration with provider', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ 
        network: 'regtest',
        ordinalsProvider: provider
      } as any);
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const validation = await sdk.lifecycle.validateMigration(draft, 'did:btco');
      
      expect(validation.valid).toBe(true);
      expect(validation.checks.bitcoinReadiness).toBe(true);
    });

    test('fails validation for btco without provider', async () => {
      const sdk = OriginalsSDK.create({ network: 'regtest' });
      const draft = await sdk.lifecycle.createDraft(resources);
      
      const validation = await sdk.lifecycle.validateMigration(draft, 'did:btco');
      
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Bitcoin inscription requires an ordinalsProvider to be configured');
      expect(validation.checks.bitcoinReadiness).toBe(false);
    });

    test('rejects invalid layer transition (btco to webvh)', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ 
        network: 'regtest',
        ordinalsProvider: provider
      } as any);
      
      const draft = await sdk.lifecycle.createDraft(resources);
      await sdk.lifecycle.publish(draft, 'example.com');
      await sdk.lifecycle.inscribe(draft, { feeRate: 10 });
      
      const validation = await sdk.lifecycle.validateMigration(draft, 'did:webvh');
      
      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('Invalid migration'))).toBe(true);
      expect(validation.checks.layerTransition).toBe(false);
    });

    test('rejects asset with no resources', async () => {
      const config: any = { network: 'regtest', defaultKeyType: 'Ed25519' };
      const didManager = new DIDManager(config);
      const credentialManager = new CredentialManager(config);
      const lm = new LifecycleManager(config, didManager, credentialManager);
      
      // Create a fake asset with no resources
      const fakeAsset = {
        currentLayer: 'did:peer' as const,
        resources: [],
        did: { id: 'did:peer:test' },
        credentials: []
      };
      
      const validation = await lm.validateMigration(fakeAsset as any, 'did:webvh');
      
      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('at least one resource'))).toBe(true);
    });

    test('rejects asset with invalid resource hash', async () => {
      const config: any = { network: 'regtest', defaultKeyType: 'Ed25519' };
      const didManager = new DIDManager(config);
      const credentialManager = new CredentialManager(config);
      const lm = new LifecycleManager(config, didManager, credentialManager);
      
      const fakeAsset = {
        currentLayer: 'did:peer' as const,
        resources: [{ id: 'r1', type: 'text', contentType: 'text/plain', hash: 'not-hex!' }],
        did: { id: 'did:peer:test' },
        credentials: []
      };
      
      const validation = await lm.validateMigration(fakeAsset as any, 'did:webvh');
      
      expect(validation.valid).toBe(false);
      expect(validation.errors.some(e => e.includes('invalid hash'))).toBe(true);
    });

    test('warns about large manifest sizes', async () => {
      const provider = new MockOrdinalsProvider();
      const sdk = OriginalsSDK.create({ 
        network: 'regtest',
        ordinalsProvider: provider
      } as any);
      
      // Create asset with many resources to increase manifest size
      // Need 1000+ resources to exceed 100KB threshold (each resource adds ~100 bytes)
      const manyResources = Array.from({ length: 1200 }, (_, i) => ({
        id: `resource-${i}-with-longer-name`,
        type: 'text',
        content: 'x'.repeat(200),
        contentType: 'text/plain',
        hash: 'a'.repeat(64)
      }));
      
      const draft = await sdk.lifecycle.createDraft(manyResources);
      const validation = await sdk.lifecycle.validateMigration(draft, 'did:btco');
      
      expect(validation.warnings.some(w => w.includes('Large manifest'))).toBe(true);
    });

    test('validates credentials structure', async () => {
      const config: any = { network: 'regtest', defaultKeyType: 'Ed25519' };
      const didManager = new DIDManager(config);
      const credentialManager = new CredentialManager(config);
      const lm = new LifecycleManager(config, didManager, credentialManager);
      
      const fakeAsset = {
        currentLayer: 'did:peer' as const,
        resources: [{ id: 'r1', type: 'text', contentType: 'text/plain', hash: 'deadbeef' }],
        did: { id: 'did:peer:test' },
        credentials: [
          { type: ['VerifiableCredential'], issuer: 'did:test:issuer', issuanceDate: '2024-01-01' }
        ]
      };
      
      const validation = await lm.validateMigration(fakeAsset as any, 'did:webvh');
      
      expect(validation.checks.credentialsValid).toBe(true);
    });

    test('warns about credentials with missing fields', async () => {
      const config: any = { network: 'regtest', defaultKeyType: 'Ed25519' };
      const didManager = new DIDManager(config);
      const credentialManager = new CredentialManager(config);
      const lm = new LifecycleManager(config, didManager, credentialManager);
      
      const fakeAsset = {
        currentLayer: 'did:peer' as const,
        resources: [{ id: 'r1', type: 'text', contentType: 'text/plain', hash: 'deadbeef' }],
        did: { id: 'did:peer:test' },
        credentials: [
          { type: ['VerifiableCredential'] } // Missing issuer and issuanceDate
        ]
      };
      
      const validation = await lm.validateMigration(fakeAsset as any, 'did:webvh');
      
      expect(validation.warnings.some(w => w.includes('missing fields'))).toBe(true);
    });
  });
});

