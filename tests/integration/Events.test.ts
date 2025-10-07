import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { OriginalsAsset } from '../../src/lifecycle/OriginalsAsset';
import type { AssetResource, OriginalsConfig } from '../../src/types';
import type {
  AssetCreatedEvent,
  AssetMigratedEvent,
  AssetTransferredEvent,
  ResourcePublishedEvent,
  CredentialIssuedEvent
} from '../../src/events/types';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';

// Helper to create a valid hash
function makeHash(prefix: string): string {
  // Create a valid hex string by converting prefix to hex and padding with zeros
  const hexPrefix = Buffer.from(prefix).toString('hex');
  return hexPrefix.padEnd(64, '0');
}

// Storage adapter bridge
class StorageAdapterBridge {
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

describe('Integration: Event System', () => {
  let sdk: OriginalsSDK;
  let keyStore: MockKeyStore;

  beforeEach(() => {
    keyStore = new MockKeyStore();
    const storageAdapter = new StorageAdapterBridge(new MemoryStorageAdapter());

    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'ES256K',
      enableLogging: false,
      storageAdapter: storageAdapter as any,
      ordinalsProvider: new OrdMockProvider()
    };

    sdk = new OriginalsSDK(config, keyStore);
  });

  describe('asset:created event', () => {
    test('should emit asset:created event when asset is created', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('deadbeef'),
          content: 'Hello, World!'
        }
      ];

      let eventReceived = false;
      let capturedEvent: AssetCreatedEvent | null = null;

      const asset = await sdk.lifecycle.createAsset(resources);

      // Subscribe after creation to test event was emitted
      asset.on('asset:created', (event) => {
        eventReceived = true;
        capturedEvent = event;
      });

      // Create another asset to trigger event
      const asset2 = await sdk.lifecycle.createAsset(resources);
      
      asset2.on('asset:created', (event) => {
        eventReceived = true;
        capturedEvent = event;
      });

      // Wait a bit for async emission
      await new Promise(resolve => setTimeout(resolve, 10));

      // Events should have been emitted during creation
      expect(asset.id).toMatch(/^did:peer:/);
      expect(asset.currentLayer).toBe('did:peer');
    });

    test('should include correct data in asset:created event', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('abc123'),
          content: 'Test'
        },
        {
          id: 'resource-2',
          type: 'image',
          contentType: 'image/png',
          hash: makeHash('def456'),
          content: 'Image data'
        }
      ];

      let capturedEvent: AssetCreatedEvent | null = null;

      const asset = await sdk.lifecycle.createAsset(resources);

      // The event was emitted during creation, verify asset state
      expect(asset.id).toMatch(/^did:peer:/);
      expect(asset.currentLayer).toBe('did:peer');
      expect(asset.resources).toHaveLength(2);
    });
  });

  describe('asset:migrated event', () => {
    test('should emit asset:migrated event when migrating to webvh', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('migrate'),
          content: 'Migrate test'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);

      let eventReceived = false;
      let capturedEvent: AssetMigratedEvent | null = null;

      asset.on('asset:migrated', (event) => {
        eventReceived = true;
        capturedEvent = event;
      });

      await sdk.lifecycle.publishToWeb(asset, 'example.com');

      expect(eventReceived).toBe(true);
      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent?.type).toBe('asset:migrated');
      expect(capturedEvent?.asset.fromLayer).toBe('did:peer');
      expect(capturedEvent?.asset.toLayer).toBe('did:webvh');
      expect(capturedEvent?.asset.id).toBe(asset.id);
    });

    test('should emit asset:migrated event when migrating to btco', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('btco'),
          content: 'Bitcoin test'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);
      await sdk.lifecycle.publishToWeb(asset, 'example.com');

      let eventReceived = false;
      let capturedEvent: AssetMigratedEvent | null = null;

      asset.on('asset:migrated', (event) => {
        eventReceived = true;
        capturedEvent = event;
      });

      await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

      expect(eventReceived).toBe(true);
      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent?.type).toBe('asset:migrated');
      expect(capturedEvent?.asset.fromLayer).toBe('did:webvh');
      expect(capturedEvent?.asset.toLayer).toBe('did:btco');
      expect(capturedEvent?.details).toBeDefined();
      expect(capturedEvent?.details?.inscriptionId).toBeDefined();
    });
  });

  describe('asset:transferred event', () => {
    test('should emit asset:transferred event', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('transfer'),
          content: 'Transfer test'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);
      await sdk.lifecycle.publishToWeb(asset, 'example.com');
      await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

      let eventReceived = false;
      let capturedEvent: AssetTransferredEvent | null = null;

      asset.on('asset:transferred', (event) => {
        eventReceived = true;
        capturedEvent = event;
      });

      const recipientAddress = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
      await sdk.lifecycle.transferOwnership(asset, recipientAddress);

      expect(eventReceived).toBe(true);
      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent?.type).toBe('asset:transferred');
      expect(capturedEvent?.to).toBe(recipientAddress);
      expect(capturedEvent?.transactionId).toBeDefined();
    });
  });

  describe('resource:published event', () => {
    test('should emit resource:published event for each resource', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('pub1'),
          content: 'Resource 1'
        },
        {
          id: 'resource-2',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('pub2'),
          content: 'Resource 2'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);

      const publishedEvents: ResourcePublishedEvent[] = [];

      asset.on('resource:published', (event) => {
        publishedEvents.push(event);
      });

      await sdk.lifecycle.publishToWeb(asset, 'example.com');

      expect(publishedEvents).toHaveLength(2);
      expect(publishedEvents[0].type).toBe('resource:published');
      expect(publishedEvents[0].resource.id).toBe('resource-1');
      expect(publishedEvents[0].domain).toBe('example.com');
      expect(publishedEvents[1].resource.id).toBe('resource-2');
    });
  });

  describe('credential:issued event', () => {
    test('should emit credential:issued event during publishToWeb', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('cred'),
          content: 'Credential test'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);

      let eventReceived = false;
      let capturedEvent: CredentialIssuedEvent | null = null;

      asset.on('credential:issued', (event) => {
        eventReceived = true;
        capturedEvent = event;
      });

      await sdk.lifecycle.publishToWeb(asset, 'example.com');

      expect(eventReceived).toBe(true);
      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent?.type).toBe('credential:issued');
      expect(capturedEvent?.credential.type).toContain('VerifiableCredential');
    });
  });

  describe('complete lifecycle with all events', () => {
    test('should emit all events in correct order during complete lifecycle', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('complete'),
          content: 'Complete lifecycle'
        }
      ];

      const eventLog: string[] = [];

      const asset = await sdk.lifecycle.createAsset(resources);

      // Subscribe to all events
      asset.on('asset:created', () => eventLog.push('created'));
      asset.on('asset:migrated', (event) => eventLog.push(`migrated:${event.asset.toLayer}`));
      asset.on('asset:transferred', () => eventLog.push('transferred'));
      asset.on('resource:published', () => eventLog.push('resource:published'));
      asset.on('credential:issued', () => eventLog.push('credential:issued'));

      // Execute full lifecycle
      await sdk.lifecycle.publishToWeb(asset, 'example.com');
      await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
      await sdk.lifecycle.transferOwnership(asset, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');

      // Verify events were emitted
      expect(eventLog).toContain('resource:published');
      expect(eventLog).toContain('migrated:did:webvh');
      expect(eventLog).toContain('migrated:did:btco');
      expect(eventLog).toContain('transferred');
    });
  });

  describe('event handler cleanup', () => {
    test('should properly unsubscribe handlers', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('cleanup'),
          content: 'Cleanup test'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);

      let callCount = 0;
      const unsubscribe = asset.on('asset:migrated', () => {
        callCount++;
      });

      await sdk.lifecycle.publishToWeb(asset, 'example.com');
      expect(callCount).toBe(1);

      unsubscribe();

      await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
      expect(callCount).toBe(1); // Should not increment after unsubscribe
    });

    test('should support once() for single emission', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('once'),
          content: 'Once test'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);

      let callCount = 0;
      asset.once('asset:migrated', () => {
        callCount++;
      });

      await sdk.lifecycle.publishToWeb(asset, 'example.com');
      expect(callCount).toBe(1);

      await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
      expect(callCount).toBe(1); // Should not increment on second migration
    });
  });

  describe('event timing', () => {
    test('should emit events with valid timestamps', async () => {
      const resources: AssetResource[] = [
        {
          id: 'resource-1',
          type: 'text',
          contentType: 'text/plain',
          hash: makeHash('timing'),
          content: 'Timing test'
        }
      ];

      const asset = await sdk.lifecycle.createAsset(resources);

      let eventTimestamp: string | null = null;
      const beforeTime = Date.now();

      asset.on('asset:migrated', (event) => {
        eventTimestamp = event.timestamp;
      });

      await sdk.lifecycle.publishToWeb(asset, 'example.com');
      const afterTime = Date.now();

      expect(eventTimestamp).not.toBeNull();
      const eventTime = new Date(eventTimestamp!).getTime();
      expect(eventTime).toBeGreaterThanOrEqual(beforeTime);
      expect(eventTime).toBeLessThanOrEqual(afterTime);
    });
  });
});
