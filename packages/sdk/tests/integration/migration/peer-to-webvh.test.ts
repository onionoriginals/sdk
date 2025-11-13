/**
 * Integration tests for peer → webvh migration
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import { MigrationStateEnum } from '../../../src/migration/types';

describe('Peer to WebVH Migration', () => {
  let sdk: OriginalsSDK;
  let migrationManager: MigrationManager;

  beforeEach(() => {
    // Reset singleton
    MigrationManager.resetInstance();

    // Create SDK instance
    sdk = OriginalsSDK.create({
      network: 'signet',
      defaultKeyType: 'Ed25519'
    });

    // Initialize migration manager
    migrationManager = MigrationManager.getInstance(
      sdk['config'],
      sdk.did,
      sdk.credentials
    );
  });

  test('should successfully migrate from peer to webvh', async () => {
    // Create a peer DID
    const resources = [
      {
        id: 'resource-1',
        type: 'Image',
        contentType: 'image/png',
        hash: 'abc123',
        content: 'test-content'
      }
    ];

    const peerDid = await sdk.did.createDIDPeer(resources);

    // Migrate to webvh
    const result = await migrationManager.migrate({
      sourceDid: peerDid.id,
      targetLayer: 'webvh',
      domain: 'example.com'
    });

    // Verify migration success
    expect(result.success).toBe(true);
    expect(result.state).toBe(MigrationStateEnum.COMPLETED);
    expect(result.targetDid).toBeDefined();
    expect(result.targetDid).toContain('did:webvh:');
    expect(result.sourceDid).toBe(peerDid.id);

    // Verify audit record was created
    expect(result.auditRecord).toBeDefined();
    expect(result.auditRecord.finalState).toBe(MigrationStateEnum.COMPLETED);
    expect(result.auditRecord.errors).toHaveLength(0);
  });

  test('should fail migration with invalid domain', async () => {
    const resources = [
      {
        id: 'resource-1',
        type: 'Image',
        contentType: 'image/png',
        hash: 'abc123'
      }
    ];

    const peerDid = await sdk.did.createDIDPeer(resources);

    // Attempt migration without domain
    const result = await migrationManager.migrate({
      sourceDid: peerDid.id,
      targetLayer: 'webvh'
      // Missing domain
    });

    // Verify migration failed
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('VALIDATION_FAILED');
  });

  test('should track migration state throughout process', async () => {
    const resources = [
      {
        id: 'resource-1',
        type: 'Image',
        contentType: 'image/png',
        hash: 'abc123'
      }
    ];

    const peerDid = await sdk.did.createDIDPeer(resources);

    // Start migration
    const migrationPromise = migrationManager.migrate({
      sourceDid: peerDid.id,
      targetLayer: 'webvh',
      domain: 'example.com'
    });

    const result = await migrationPromise;

    // Check final state
    const state = await migrationManager.getMigrationStatus(result.migrationId);
    expect(state).toBeDefined();
    expect(state.state).toBe(MigrationStateEnum.COMPLETED);
    expect(state.progress).toBe(100);
  });

  test('should get migration history for DID', async () => {
    const resources = [
      {
        id: 'resource-1',
        type: 'Image',
        contentType: 'image/png',
        hash: 'abc123'
      }
    ];

    const peerDid = await sdk.did.createDIDPeer(resources);

    // Perform migration
    await migrationManager.migrate({
      sourceDid: peerDid.id,
      targetLayer: 'webvh',
      domain: 'example.com'
    });

    // Get migration history
    const history = await migrationManager.getMigrationHistory(peerDid.id);

    expect(history).toBeDefined();
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].sourceDid).toBe(peerDid.id);
    expect(history[0].targetLayer).toBe('webvh');
  });

  test('should estimate migration cost', async () => {
    const resources = [
      {
        id: 'resource-1',
        type: 'Image',
        contentType: 'image/png',
        hash: 'abc123'
      }
    ];

    const peerDid = await sdk.did.createDIDPeer(resources);

    // Estimate cost
    const cost = await migrationManager.estimateMigrationCost(
      peerDid.id,
      'webvh'
    );

    expect(cost).toBeDefined();
    expect(cost.totalCost).toBeDefined();
    expect(cost.networkFees).toBeDefined();
    expect(cost.storageCost).toBeDefined();
    expect(cost.totalCost).toBeDefined();
    expect(cost.currency).toBe('sats');
  });
});
