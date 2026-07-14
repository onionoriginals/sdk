// SKIPPED (#279 + did:peer purge Phase 4·5/5): MigrationManager is experimental/unexported; its did:peer-based setup is parked pending #279.
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

describe.skip('RollbackManager', () => {
  // CORE-MIG-EVENTS-018/happy — rollback succeeds when checkpoint available
  describe('rollback() — success case', () => {
    it('should succeed and return ROLLED_BACK state when checkpoint is valid', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
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
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
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
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
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
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
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

    // Issue #237 — a btco-targeted migration is NOT fully reversible: rollback
    // must report PARTIALLY_ROLLED_BACK with the irreversible artifacts rather
    // than an unqualified success that invites a fee-paying retry.
    it('rollback of a btco-targeted migration reports PARTIALLY_ROLLED_BACK with irreversible artifacts', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
      ]);

      const migrationId = 'mig_btco_src_rollback';
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'btco',
      });

      const failureError = Object.assign(new Error('satoshi unknown'), {
        details: { inscriptionId: 'abc123i0', txid: 'deadbeef', commitTxId: 'c0ffee' }
      });
      const result = await rollbackManager.rollback(migrationId, checkpoint.checkpointId!, { error: failureError });

      expect(result.success).toBe(false);
      expect(result.restoredState).toBe(MigrationStateEnum.PARTIALLY_ROLLED_BACK);
      expect(result.irreversibleArtifacts).toBeDefined();
      expect(result.irreversibleArtifacts!.length).toBeGreaterThan(0);
      expect(result.irreversibleArtifacts![0].type).toBe('bitcoin-inscription');
      // On-chain identifiers from the failing error are surfaced for recovery
      expect(result.irreversibleArtifacts![0].details).toMatchObject({
        inscriptionId: 'abc123i0',
        txid: 'deadbeef',
        commitTxId: 'c0ffee'
      });
    });
    // Review follow-up: a btco migration that failed BEFORE the anchoring step
    // (no transaction could have been broadcast) rolls back cleanly.
    it('btco migration that failed before anchoring reports a clean ROLLED_BACK', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
      ]);

      const migrationId = 'mig_btco_preanchor_rollback';
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'btco',
      });

      const result = await rollbackManager.rollback(migrationId, checkpoint.checkpointId!, {
        error: new Error('ORD_PROVIDER_REQUIRED'),
        stateAtFailure: MigrationStateEnum.IN_PROGRESS
      });

      expect(result.success).toBe(true);
      expect(result.restoredState).toBe(MigrationStateEnum.ROLLED_BACK);
      expect(result.irreversibleArtifacts).toBeUndefined();
    });

    // Issue #302 — the positive broadcast signal must win over the negative
    // pre-anchoring state inference. A migration whose tracked state at
    // failure is IN_PROGRESS (a "pre-anchoring" state that the choreography
    // heuristic alone would treat as never-broadcast) but whose error carries
    // on-chain artifacts (a txid) provably DID broadcast — rollback must
    // report PARTIALLY_ROLLED_BACK, not a clean success that invites a
    // fee-paying retry (regression against a broadcast-before-ANCHORING op).
    it('btco migration with broadcast artifacts reports PARTIALLY_ROLLED_BACK even when stateAtFailure looks pre-anchoring', async () => {
      const { sdk, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
      ]);

      const migrationId = 'mig_btco_broadcast_in_progress';
      const checkpoint = await checkpointManager.createCheckpoint(migrationId, {
        sourceDid: peerDid.id,
        targetLayer: 'btco',
      });

      const failureError = Object.assign(new Error('reveal broadcast then indexer timeout'), {
        details: { txid: 'broadcasted-txid', revealTxId: 'reveal-abc' }
      });
      const result = await rollbackManager.rollback(migrationId, checkpoint.checkpointId!, {
        error: failureError,
        stateAtFailure: MigrationStateEnum.IN_PROGRESS
      });

      expect(result.success).toBe(false);
      expect(result.restoredState).toBe(MigrationStateEnum.PARTIALLY_ROLLED_BACK);
      expect(result.irreversibleArtifacts).toBeDefined();
      expect(result.irreversibleArtifacts![0].details).toMatchObject({
        txid: 'broadcasted-txid',
        revealTxId: 'reveal-abc'
      });
    });


    // CORE-MIG-EVENTS-024/happy — rollback restores storage references (checkpoint contains them)
    it('rollback captures storageReferences from checkpoint', async () => {
      const { sdk, config, checkpointManager, rollbackManager } = makeRollbackSetup();

      const peerDid = await sdk.did.createDIDPeer([
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
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
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
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
        { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' }
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
