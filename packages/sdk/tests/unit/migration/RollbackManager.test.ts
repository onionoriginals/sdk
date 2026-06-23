/**
 * Unit tests for RollbackManager
 * Covers CORE-MIG-EVENTS-018 (rollback happy/error), -024 (layer-specific rollback)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { RollbackManager } from '../../../src/migration/rollback/RollbackManager';
import { CheckpointManager } from '../../../src/migration/checkpoint/CheckpointManager';
import { MigrationStateEnum, MigrationErrorType } from '../../../src/migration/types';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';

function makeRollbackSetup() {
  MigrationManager.resetInstance();
  const sdk = OriginalsSDK.create({
    network: 'signet',
    defaultKeyType: 'Ed25519'
  });
  const config = sdk['config'] as any;
  const checkpointManager = new CheckpointManager(config, sdk.did, sdk.credentials);
  const rollbackManager = new RollbackManager(config, checkpointManager, sdk.did);
  return { sdk, config, checkpointManager, rollbackManager };
}

describe('RollbackManager', () => {
  // CORE-MIG-EVENTS-018/happy — rollback succeeds when checkpoint available
  describe('rollback() — success case', () => {
    it('should succeed and return ROLLED_BACK state when checkpoint is valid', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);

      const migrationId = 'mig_rollback_happy';
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      const result = await rollbackManager.rollback(migrationId, checkpoint.checkpointId!);

      expect(result.success).toBe(true);
      expect(result.migrationId).toBe(migrationId);
      expect(result.checkpointId).toBe(checkpoint.checkpointId);
      expect(result.restoredState).toBe(MigrationStateEnum.ROLLED_BACK);
      expect(result.errors).toHaveLength(0);
      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include the checkpoint ID in the result', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);

      const migrationId = 'mig_chkid_in_result';
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      const result = await rollbackManager.rollback(migrationId, checkpoint.checkpointId!);

      expect(result.checkpointId).toBe(checkpoint.checkpointId);
    });
  });

  // CORE-MIG-EVENTS-018/error — rollback fails gracefully without checkpoint
  describe('rollback() — failure cases', () => {
    it('should return failure with QUARANTINED state when checkpoint not found', async () => {
      const { rollbackManager } = makeRollbackSetup();

      const result = await rollbackManager.rollback('mig_missing', 'chk_does_not_exist');

      expect(result.success).toBe(false);
      expect(result.restoredState).toBe(MigrationStateEnum.QUARANTINED);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe(MigrationErrorType.ROLLBACK_ERROR);
      expect(result.errors[0].code).toBe('CHECKPOINT_NOT_FOUND');
    });

    it('should return failure when checkpoint belongs to a different migration', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);

      // Create checkpoint for migrationA
      const checkpoint = await checkpointManager.createCheckpoint('mig_A', {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      // Attempt to roll back migrationB using migrationA's checkpoint
      const result = await rollbackManager.rollback('mig_B', checkpoint.checkpointId!);

      expect(result.success).toBe(false);
      expect(result.restoredState).toBe(MigrationStateEnum.QUARANTINED);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('CHECKPOINT_MISMATCH');
    });
  });

  // CORE-MIG-EVENTS-024/happy — rollback restores source layer state (verifies source DID still resolves)
  describe('rollback() — layer-specific logic', () => {
    it('should verify source peer DID is still resolvable after rollback', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);

      const migrationId = 'mig_peer_rollback';
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      const result = await rollbackManager.rollback(migrationId, checkpoint.checkpointId!);

      // Rollback should succeed — source DID is still resolvable
      expect(result.success).toBe(true);

      // Source DID should still be resolvable post-rollback
      const resolved = await sdk.did.resolveDID(peerDid.id);
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(peerDid.id);
    });

    // CORE-MIG-EVENTS-024/happy — rollback layer-specific logic for Bitcoin
    it('rollback for btco source still verifies source DID can be resolved', async () => {
      // NOTE: Bitcoin transactions cannot truly be reversed, but rollback still
      // verifies the source DID remains valid. We simulate this by using a
      // did:peer source (the actual btco layer would require live Bitcoin infra).
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);

      const migrationId = 'mig_btco_src_rollback';
      // Inject a checkpoint that claims to be from a btco source
      // (source DID is still did:peer so it can be resolved in this test env)
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'btco',
      });

      const result = await rollbackManager.rollback(migrationId, checkpoint.checkpointId!);

      // Source DID resolves → rollback logic runs and succeeds
      expect(result.success).toBe(true);
      expect(result.restoredState).toBe(MigrationStateEnum.ROLLED_BACK);
    });

    // CORE-MIG-EVENTS-024/happy — rollback restores storage references (checkpoint contains them)
    it('rollback captures storageReferences from checkpoint', async () => {
      const { sdk, config, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);

      const migrationId = 'mig_storage_refs';
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      // Checkpoint includes storageReferences field (even if empty at this stage)
      expect(checkpoint.storageReferences).toBeDefined();

      const result = await rollbackManager.rollback(migrationId, checkpoint.checkpointId!);
      expect(result.success).toBe(true);
    });
  });

  // CORE-MIG-EVENTS-018 — canRollback()
  describe('canRollback()', () => {
    it('returns true when checkpoint exists and belongs to migration', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);
      const migrationId = 'mig_can_rollback';
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      expect(await rollbackManager.canRollback(migrationId, checkpoint.checkpointId!)).toBe(true);
    });

    it('returns false when checkpoint does not exist', async () => {
      const { rollbackManager } = makeRollbackSetup();
      expect(await rollbackManager.canRollback('mig_x', 'chk_nonexistent')).toBe(false);
    });

    it('returns false when checkpoint belongs to a different migration', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
      ]);
      const checkpoint = await checkpointManager.createCheckpoint('mig_owner', {
        sourceDid: peerDid.id,
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      expect(await rollbackManager.canRollback('mig_different', checkpoint.checkpointId!)).toBe(false);
    });
  });
});
