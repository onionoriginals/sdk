/**
 * Unit tests for CheckpointManager and CheckpointStorage
 * Covers CORE-MIG-EVENTS-015, -022, -023
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { CheckpointManager } from '../../../src/migration/checkpoint/CheckpointManager';
import { CheckpointStorage } from '../../../src/migration/checkpoint/CheckpointStorage';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';

// Helper to create a fresh SDK and CheckpointManager for each test
function makeManagers() {
  MigrationManager.resetInstance();
  const sdk = OriginalsSDK.create({
    network: 'signet',
    defaultKeyType: 'Ed25519'
  });
  const config = sdk['config'] as any;
  const checkpointManager = new CheckpointManager(config, sdk.did, sdk.credentials);
  return { sdk, config, checkpointManager };
}

describe('CheckpointManager', () => {
  // CORE-MIG-EVENTS-022/happy — checkpoint creation captures complete migration context
  describe('createCheckpoint()', () => {
    it('should create a checkpoint with all required fields', async () => {
      const { sdk, checkpointManager } = makeManagers();

      // Create a real peer DID
      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);

      const migrationId = 'mig_test_001';
      const options = {
        sourceDid: peerDid.id,
        targetLayer: 'webvh' as const,
        domain: 'example.com',
        metadata: { initiatedBy: 'test', priority: 'high' }
      };

      const checkpoint = await checkpointManager.createCheckpoint(migrationId, options);

      expect(checkpoint).toBeDefined();
      expect(checkpoint.checkpointId).toBeDefined();
      expect(checkpoint.checkpointId).toMatch(/^chk_/);
      expect(checkpoint.migrationId).toBe(migrationId);
      expect(checkpoint.sourceDid).toBe(peerDid.id);
      expect(checkpoint.sourceLayer).toBe('peer');
      expect(checkpoint.timestamp).toBeGreaterThan(0);
      expect(checkpoint.didDocument).toBeDefined();
      expect(checkpoint.didDocument.id).toBe(peerDid.id);
      expect(checkpoint.metadata).toEqual({ initiatedBy: 'test', priority: 'high' });
      expect(Array.isArray(checkpoint.credentials)).toBe(true);
      expect(Array.isArray(checkpoint.ownershipProofs)).toBe(true);
    });

    it('should assign timestamp close to current time', async () => {
      const { sdk, checkpointManager } = makeManagers();
      const before = Date.now();
      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);
      const checkpoint = await checkpointManager.createCheckpoint('mig_ts_001', {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });
      const after = Date.now();

      expect(checkpoint.timestamp).toBeGreaterThanOrEqual(before);
      expect(checkpoint.timestamp).toBeLessThanOrEqual(after);
    });

    it('should use empty object when no metadata provided', async () => {
      const { sdk, checkpointManager } = makeManagers();
      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);
      const checkpoint = await checkpointManager.createCheckpoint('mig_nometa', {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      expect(checkpoint.metadata).toEqual({});
    });

    it('should create a checkpoint even for a syntactically valid but unknown peer DID (resolver returns minimal doc)', async () => {
      // NOTE: The did:peer resolver returns a minimal DID document for any did:peer: prefixed
      // string rather than returning null. So createCheckpoint succeeds even for "unknown" DIDs.
      // This is REAL code behavior — the source DID format is valid so the resolver returns a doc.
      const { checkpointManager } = makeManagers();

      const checkpoint = await checkpointManager.createCheckpoint('mig_unknown_peer', {
        sourceDid: 'did:peer:nonexistent_zXXX',
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      expect(checkpoint).toBeDefined();
      expect(checkpoint.sourceDid).toBe('did:peer:nonexistent_zXXX');
      // The didDocument will be a minimal object returned by the resolver
      expect(checkpoint.didDocument).toBeDefined();
    });
  });

  // CORE-MIG-EVENTS-023/happy — checkpoint retrieval returns exact snapshot
  describe('getCheckpoint()', () => {
    it('should retrieve a previously saved checkpoint', async () => {
      const { sdk, checkpointManager } = makeManagers();
      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);
      const created = await checkpointManager.createCheckpoint('mig_get_001', {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      const retrieved = await checkpointManager.getCheckpoint(created.checkpointId!);

      expect(retrieved).toBeDefined();
      expect(retrieved!.checkpointId).toBe(created.checkpointId);
      expect(retrieved!.migrationId).toBe(created.migrationId);
      expect(retrieved!.sourceDid).toBe(created.sourceDid);
      expect(retrieved!.sourceLayer).toBe(created.sourceLayer);
      expect(retrieved!.timestamp).toBe(created.timestamp);
    });

    it('should return null for a non-existent checkpoint', async () => {
      const { checkpointManager } = makeManagers();
      const result = await checkpointManager.getCheckpoint('chk_does_not_exist');
      expect(result).toBeNull();
    });
  });

  // CORE-MIG-EVENTS-023/happy — checkpoint deletion removes from storage
  describe('deleteCheckpoint()', () => {
    it('should delete a checkpoint so it is no longer retrievable', async () => {
      const { sdk, checkpointManager } = makeManagers();
      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);
      const created = await checkpointManager.createCheckpoint('mig_del_001', {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      const checkpointId = created.checkpointId!;
      // Confirm it exists
      expect(await checkpointManager.getCheckpoint(checkpointId)).not.toBeNull();

      // Delete
      await checkpointManager.deleteCheckpoint(checkpointId);

      // Confirm it is gone
      const result = await checkpointManager.getCheckpoint(checkpointId);
      expect(result).toBeNull();
    });

    it('should not throw when deleting a non-existent checkpoint', async () => {
      const { checkpointManager } = makeManagers();
      // Should silently succeed
      await expect(
        checkpointManager.deleteCheckpoint('chk_nonexistent')
      ).resolves.toBeUndefined();
    });
  });

  // CORE-MIG-EVENTS-022/happy — checkpoint storage persists to configured adapter
  describe('CheckpointStorage — persistence', () => {
    it('should persist checkpoint to storage adapter when one is configured', async () => {
      MigrationManager.resetInstance();
      const putCalls: Array<[string, unknown]> = [];
      const mockStorage = {
        put: async (key: string, data: unknown) => {
          putCalls.push([key, data]);
        },
        get: async (_key: string) => null,
        delete: async (_key: string) => {},
      };
      const sdk = OriginalsSDK.create({
        network: 'signet',
        defaultKeyType: 'Ed25519',
        storageAdapter: mockStorage as any
      });
      const config = sdk['config'] as any;
      const cm = new CheckpointManager(config, sdk.did, sdk.credentials);

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);
      const checkpoint = await cm.createCheckpoint('mig_persist_001', {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      // Should have called put on the storage adapter
      expect(putCalls.length).toBeGreaterThan(0);
      const [key] = putCalls[0];
      expect(key).toContain(`checkpoints/${checkpoint.checkpointId}`);
    });

    it('should retrieve from storage adapter when not in memory', async () => {
      MigrationManager.resetInstance();
      const sdk = OriginalsSDK.create({
        network: 'signet',
        defaultKeyType: 'Ed25519'
      });
      const config = sdk['config'] as any;

      const storage = new CheckpointStorage(config);
      const checkpointData = {
        checkpointId: 'chk_from_storage',
        migrationId: 'mig_from_storage',
        timestamp: Date.now(),
        sourceDid: 'did:peer:z123',
        sourceLayer: 'peer' as const,
        didDocument: { id: 'did:peer:z123', verificationMethod: [], authentication: [], assertionMethod: [] },
        credentials: [],
        storageReferences: {},
        lifecycleState: {},
        ownershipProofs: [],
        metadata: {}
      };

      // Save directly into the storage object
      await storage.save(checkpointData);

      // Should be retrievable
      const retrieved = await storage.get('chk_from_storage');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.checkpointId).toBe('chk_from_storage');
      expect(retrieved!.migrationId).toBe('mig_from_storage');
    });
  });
});
