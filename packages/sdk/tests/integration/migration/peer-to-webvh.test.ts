// SKIPPED (#279 + did:peer purge Phase 4·5/5): MigrationManager is experimental/unexported; its did:peer-based setup is parked pending #279.
/**
 * Integration tests for peer → webvh migration
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import { AuditLogger, AuditSignerConfig } from '../../../src/migration/audit/AuditLogger';
import { MigrationStateEnum } from '../../../src/migration/types';

describe.skip('Peer to WebVH Migration', () => {
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
        hash: '0a3666a0710c08aa6d0de92ce72beeb5b93124cce1bf3701c9d6cdeb543cb73e',
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

  test('records a signed audit entry that verifies when a signer is configured', async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    const auditSigner: AuditSignerConfig = {
      privateKey,
      publicKey,
      verificationMethod: 'did:key:z6MkAudit#z6MkAudit',
    };

    MigrationManager.resetInstance();
    const signedSdk = OriginalsSDK.create({ network: 'signet', defaultKeyType: 'Ed25519' });
    const signedManager = MigrationManager.getInstance(
      { ...signedSdk['config'], auditSigner } as any,
      signedSdk.did,
      signedSdk.credentials
    );

    const peerDid = await signedSdk.did.createDIDPeer([
      { id: 'resource-1', type: 'Image', contentType: 'image/png', hash: '0a3666a0710c08aa6d0de92ce72beeb5b93124cce1bf3701c9d6cdeb543cb73e', content: 'test-content' }
    ]);

    await signedManager.migrate({ sourceDid: peerDid.id, targetLayer: 'webvh', domain: 'example.com' });

    const history = await signedManager.getMigrationHistory(peerDid.id);
    expect(history.length).toBeGreaterThan(0);
    const record = history[0];
    expect(record.signature?.startsWith('z')).toBe(true);

    // The signed record verifies under the configured public key...
    const verifier = new AuditLogger(signedSdk['config'], auditSigner);
    expect(await verifier.verifyAuditRecord(record)).toBe(true);

    // ...but not under a different key (signatures are key-bound).
    const otherPriv = ed25519.utils.randomSecretKey();
    const otherPub = await ed25519.getPublicKeyAsync(otherPriv);
    const wrongVerifier = new AuditLogger(signedSdk['config'], {
      privateKey: otherPriv,
      publicKey: otherPub,
      verificationMethod: 'did:key:z6MkOther#z6MkOther',
    });
    expect(await wrongVerifier.verifyAuditRecord(record)).toBe(false);
  });
});
