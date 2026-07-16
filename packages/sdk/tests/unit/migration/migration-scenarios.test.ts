// SKIPPED (#279 + did:peer purge Phase 4·5/5): MigrationManager is experimental/unexported; its did:peer-based setup is parked pending #279.
/**
 * Migration validation + migration-path scenario tests
 * Covers scenarios: CORE-MIG-EVENTS-025 through CORE-MIG-EVENTS-042
 *
 * Tests assert ACTUAL behavior of the validators, state tracker, rollback manager,
 * and migration operations as found in:
 *   src/migration/validation/
 *   src/migration/checkpoint/CheckpointManager.ts
 *   src/migration/rollback/RollbackManager.ts
 *   src/migration/state/StateTracker.ts
 *   src/migration/MigrationManager.ts
 *   src/lifecycle/LifecycleManager.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import {
  MigrationStateEnum,
  MigrationValidationResult,
} from '../../../src/migration/types';
import { DIDCompatibilityValidator } from '../../../src/migration/validation/DIDCompatibilityValidator';
import { CredentialValidator } from '../../../src/migration/validation/CredentialValidator';
import { StorageValidator } from '../../../src/migration/validation/StorageValidator';
import { LifecycleValidator } from '../../../src/migration/validation/LifecycleValidator';
import { BitcoinValidator } from '../../../src/migration/validation/BitcoinValidator';
import { ValidationPipeline } from '../../../src/migration/validation/ValidationPipeline';
import { CheckpointManager } from '../../../src/migration/checkpoint/CheckpointManager';
import { RollbackManager } from '../../../src/migration/rollback/RollbackManager';
import { StateTracker } from '../../../src/migration/state/StateTracker';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';
import type { OriginalsConfig } from '../../../src/types';
import { MockOrdinalsProvider } from '../../mocks/adapters';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
  storageAdapter: new MemoryStorageAdapter(),
};

const sampleResources = [
  { id: 'res-1', type: 'Image', contentType: 'image/png', hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7', content: 'data' },
];

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-025 — Rollback-possible check (RollbackManager.canRollback)
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-025: RollbackManager.canRollback', () => {
  let sdk: OriginalsSDK;
  let checkpointManager: CheckpointManager;
  let rollbackManager: RollbackManager;

  beforeEach(() => {
    sdk = OriginalsSDK.create({ ...baseConfig });
    checkpointManager = new CheckpointManager(
      (sdk as any).config,
      sdk.did,
      sdk.credentials
    );
    rollbackManager = new RollbackManager(
      (sdk as any).config,
      checkpointManager,
      sdk.did
    );
  });

  test('[happy] returns true when a valid checkpoint exists', async () => {
    const peerDid = await sdk.did.createDIDPeer(sampleResources);
    const checkpoint = await checkpointManager.createCheckpoint('mig_test_025', {
      sourceDid: peerDid.id,
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    const canRoll = await rollbackManager.canRollback('mig_test_025', checkpoint.checkpointId!);
    expect(canRoll).toBe(true);
  });

  test('[boundary] returns false when no checkpoint exists for the id', async () => {
    const canRoll = await rollbackManager.canRollback('mig_nonexistent', 'chk_nonexistent');
    expect(canRoll).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-031 — Quick input validation (ValidationPipeline.validateQuick)
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-031: ValidationPipeline.validateQuick', () => {
  let pipeline: ValidationPipeline;

  beforeEach(() => {
    pipeline = new ValidationPipeline(
      baseConfig,
      {} as DIDManager,
      {} as CredentialManager
    );
  });

  test('[happy] passes for a basic valid peer→webvh input', () => {
    const errors = pipeline.validateQuick({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
    });
    expect(errors).toHaveLength(0);
  });

  test('[invalid-input] rejects when sourceDid is missing', () => {
    // @ts-expect-error — intentionally omitting sourceDid to exercise validation
    const errors = pipeline.validateQuick({ targetLayer: 'webvh', domain: 'example.com' });
    expect(errors.length).toBeGreaterThan(0);
    const codes = errors.map((e: any) => e.code);
    expect(codes).toContain('INVALID_SOURCE_DID');
  });

  test('[invalid-input] rejects an invalid targetLayer string', () => {
    const errors = pipeline.validateQuick({
      sourceDid: 'did:peer:z6MkValid123',
      // @ts-expect-error — intentionally using an invalid layer
      targetLayer: 'invalid-layer',
    });
    expect(errors.length).toBeGreaterThan(0);
    const codes = errors.map((e: any) => e.code);
    expect(codes).toContain('INVALID_TARGET_LAYER');
  });

  test('[invalid-input] rejects webvh migration without domain', () => {
    const errors = pipeline.validateQuick({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      // domain intentionally omitted
    });
    expect(errors.length).toBeGreaterThan(0);
    const codes = errors.map((e: any) => e.code);
    expect(codes).toContain('DOMAIN_REQUIRED');
  });

  test('[invalid-input] rejects partialMode with non-positive chunkSize', () => {
    const errors = pipeline.validateQuick({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
      partialMode: { chunkSize: 0, resumable: true },
    });
    expect(errors.length).toBeGreaterThan(0);
    const codes = errors.map((e: any) => e.code);
    expect(codes).toContain('INVALID_CHUNK_SIZE');
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-032 — DIDCompatibilityValidator
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-032: DIDCompatibilityValidator', () => {
  let sdk: OriginalsSDK;
  let validator: DIDCompatibilityValidator;

  beforeEach(() => {
    sdk = OriginalsSDK.create({ ...baseConfig });
    validator = new DIDCompatibilityValidator((sdk as any).config, sdk.did);
  });

  test('[happy] passes for peer → webvh migration', async () => {
    const peerDid = await sdk.did.createDIDPeer(sampleResources);

    const result = await validator.validate({
      sourceDid: peerDid.id,
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('[happy] passes for webvh → btco migration', async () => {
    const peerDid = await sdk.did.createDIDPeer(sampleResources);
    const webvhDid = (await sdk.did.migrateToDIDWebVH(peerDid, 'example.com')).didDocument;

    // The synthetic did:webvh has no hosted log; inject its resolution
    // (resolveDID no longer fabricates stub documents for unresolvable DIDs).
    const originalResolve = sdk.did.resolveDID.bind(sdk.did);
    (sdk.did as any).resolveDID = async (did: string) =>
      did === webvhDid.id ? webvhDid : originalResolve(did);
    try {
      const result = await validator.validate({
        sourceDid: webvhDid.id,
        targetLayer: 'btco',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    } finally {
      (sdk.did as any).resolveDID = originalResolve;
    }
  });

  test('[error] rejects btco → webvh downgrade (invalid migration path)', async () => {
    const originalResolve = sdk.did.resolveDID.bind(sdk.did);
    // Inject a synthetic btco DID document resolution
    (sdk.did as any).resolveDID = async (did: string) => {
      if (did.startsWith('did:btco:')) {
        return {
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: did,
          verificationMethod: [],
        };
      }
      return originalResolve(did);
    };

    const result = await validator.validate({
      sourceDid: 'did:btco:reg:123456789',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const errorCodes = result.errors.map(e => e.code);
    expect(errorCodes).toContain('INVALID_MIGRATION_PATH');

    // Restore original resolver
    (sdk.did as any).resolveDID = originalResolve;
  });

  test('[error] rejects peer → peer (same-layer, not a valid forward migration)', async () => {
    const peerDid = await sdk.did.createDIDPeer(sampleResources);

    const result = await validator.validate({
      sourceDid: peerDid.id,
      targetLayer: 'peer',
    });

    expect(result.valid).toBe(false);
    const codes = result.errors.map(e => e.code);
    expect(codes).toContain('INVALID_MIGRATION_PATH');
  });

  test('[error] returns error when source DID has unsupported DID method', async () => {
    // did:peer resolver can construct documents from key material without network,
    // so an unknown key still resolves. Use an unsupported DID method instead to
    // trigger the INVALID_SOURCE_DID_FORMAT / DID_VALIDATION_ERROR path.
    const result = await validator.validate({
      sourceDid: 'did:unknown:abc123unsupported',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    // The DIDCompatibilityValidator catches the unsupported format either via:
    //   - null resolution → SOURCE_DID_NOT_FOUND
    //   - null layer extraction → INVALID_SOURCE_DID_FORMAT
    //   - thrown error → DID_VALIDATION_ERROR
    expect(result.valid).toBe(false);
    const codes = result.errors.map(e => e.code);
    expect(
      codes.some(c =>
        c === 'SOURCE_DID_NOT_FOUND' ||
        c === 'INVALID_SOURCE_DID_FORMAT' ||
        c === 'DID_VALIDATION_ERROR'
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-033 — CredentialValidator
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-033: CredentialValidator', () => {
  let validator: CredentialValidator;

  beforeEach(() => {
    validator = new CredentialValidator(baseConfig, {} as CredentialManager);
  });

  test('[happy] credential compatibility passes for standard options', async () => {
    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
      credentialIssuance: true,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('[boundary] credential validation is skipped (returns valid=true) when credentialIssuance is false', async () => {
    // Actual behavior: CredentialValidator immediately returns valid=true when credentialIssuance=false
    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
      credentialIssuance: false,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('[boundary] estimated duration is non-negative', async () => {
    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    expect(result.estimatedDuration).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-034 — StorageValidator
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-034: StorageValidator', () => {
  test('[happy] storage validator passes with storage adapter in config', async () => {
    const configWithStorage: OriginalsConfig = {
      ...baseConfig,
      storageAdapter: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => [],
      } as any,
    };
    const validator = new StorageValidator(configWithStorage);

    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    // No warning about missing adapter since it's present
    const warnCodes = result.warnings.map(w => w.code);
    expect(warnCodes).not.toContain('NO_STORAGE_ADAPTER');
  });

  test('[error] storage validator warns (not errors) when no adapter configured', async () => {
    // Actual behavior: valid=true with a warning about no storage adapter (not a hard error)
    const configNoStorage: OriginalsConfig = {
      ...baseConfig,
      // storageAdapter intentionally omitted
      storageAdapter: undefined,
    };
    const validator = new StorageValidator(configNoStorage);

    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    // Current behavior: valid=true with warning (the adapter is not strictly required)
    expect(result.valid).toBe(true);
    const warnCodes = result.warnings.map(w => w.code);
    expect(warnCodes).toContain('NO_STORAGE_ADAPTER');
  });

  test('[boundary] partialMode passes with an adapter that can persist objects (no phantom putChunk probe)', async () => {
    // Issue #318: the validator used to probe `putChunk`, a method no shipped
    // StorageAdapter has, and misreported capable adapters. It now validates
    // the real persistence capabilities (putObject/getObject or legacy put/get).
    const configWithBasicStorage: OriginalsConfig = {
      ...baseConfig,
      storageAdapter: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => [],
      } as any,
    };
    const validator = new StorageValidator(configWithBasicStorage);

    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
      partialMode: { chunkSize: 1024, resumable: true },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    const warnCodes = result.warnings.map(w => w.code);
    expect(warnCodes).not.toContain('NO_CHUNKED_UPLOAD_SUPPORT');
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-035 — LifecycleValidator
// NOTE: LifecycleValidator is currently a pass-through stub. Tests assert actual behavior.
// Deactivated-asset detection is MISSING-API (not yet implemented).
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-035: LifecycleValidator', () => {
  test('[happy] lifecycle validator passes for standard asset state', async () => {
    const validator = new LifecycleValidator(baseConfig);

    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('[error] lifecycle validator rejects deactivated assets', async () => {
    const validator = new LifecycleValidator(baseConfig);

    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkDeactivated',
      targetLayer: 'webvh',
      domain: 'example.com',
      metadata: { deactivated: true },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('ASSET_DEACTIVATED');
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-036 — BitcoinValidator (network validation)
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-036: BitcoinValidator network validation', () => {
  test('[happy] passes for btco migration with ordinals provider configured', async () => {
    const provider = new MockOrdinalsProvider();
    const config = { ...baseConfig, network: 'mainnet', ordinalsProvider: provider } as OriginalsConfig;
    const bitcoinManager = new BitcoinManager(config);
    const validator = new BitcoinValidator(config, bitcoinManager);

    const result = await validator.validate({
      sourceDid: 'did:webvh:example.com:asset1',
      targetLayer: 'btco',
      feeRate: 10,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.estimatedCost.networkFees).toBeGreaterThan(0);
  });

  test('[error] fails when ordinals provider is not configured', async () => {
    // Config without ordinalsProvider
    const config = { ...baseConfig, network: 'mainnet' } as OriginalsConfig;
    // Pass undefined bitcoinManager to simulate missing provider
    const validator = new BitcoinValidator(config, undefined as any);

    const result = await validator.validate({
      sourceDid: 'did:webvh:example.com:asset1',
      targetLayer: 'btco',
    });

    expect(result.valid).toBe(false);
    const codes = result.errors.map(e => e.code);
    expect(codes).toContain('BITCOIN_PROVIDER_REQUIRED');
  });

  test('[happy] non-btco migration skips Bitcoin validation entirely', async () => {
    const config = { ...baseConfig, network: 'mainnet' } as OriginalsConfig;
    const validator = new BitcoinValidator(config, undefined as any);

    const result = await validator.validate({
      sourceDid: 'did:peer:z6MkValid123',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    // non-btco target: immediately passes with zero fees
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.estimatedCost.networkFees).toBe(0);
  });

  test('[boundary] high fee rate (>1000 sat/vB) triggers HIGH_FEE_RATE warning', async () => {
    const provider = new MockOrdinalsProvider();
    const config = { ...baseConfig, network: 'mainnet', ordinalsProvider: provider } as OriginalsConfig;
    const bitcoinManager = new BitcoinManager(config);
    const validator = new BitcoinValidator(config, bitcoinManager);

    const result = await validator.validate({
      sourceDid: 'did:webvh:example.com:asset1',
      targetLayer: 'btco',
      feeRate: 2000, // > 1000 sat/vB threshold
    });

    expect(result.valid).toBe(true); // Still valid, just warned
    const warnCodes = result.warnings.map(w => w.code);
    expect(warnCodes).toContain('HIGH_FEE_RATE');
  });

  test('warns NON_MAINNET_NETWORK (not the wrong "will use signet") on regtest (#293)', async () => {
    const provider = new MockOrdinalsProvider();
    const config = { ...baseConfig, network: 'regtest', ordinalsProvider: provider } as OriginalsConfig;
    const validator = new BitcoinValidator(config, new BitcoinManager(config));
    const result = await validator.validate({ sourceDid: 'did:webvh:example.com:a', targetLayer: 'btco', feeRate: 10 });
    const warn = result.warnings.find(w => w.code === 'NON_MAINNET_NETWORK');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('regtest');
    // The old bug claimed regtest would use signet; it must not.
    expect(warn!.message).not.toContain('signet');
  });

  test('consults the provider fee estimator when no feeRate is supplied (#293)', async () => {
    const provider = new MockOrdinalsProvider();
    let estimateCalls = 0;
    provider.estimateFee = async (blocks = 1) => { estimateCalls++; return 7 * blocks; };
    const config = { ...baseConfig, network: 'mainnet', ordinalsProvider: provider } as OriginalsConfig;
    const validator = new BitcoinValidator(config, new BitcoinManager(config));
    const result = await validator.validate({ sourceDid: 'did:webvh:example.com:a', targetLayer: 'btco' });
    expect(estimateCalls).toBeGreaterThan(0);
    // 1024 bytes * 7 sat/vB
    expect(result.estimatedCost.networkFees).toBe(1024 * 7);
  });

  test('surfaces FEE_ESTIMATION_FAILED when the estimator throws (#293)', async () => {
    const provider = new MockOrdinalsProvider();
    provider.estimateFee = async () => { throw new Error('oracle down'); };
    const config = { ...baseConfig, network: 'mainnet', ordinalsProvider: provider } as OriginalsConfig;
    const validator = new BitcoinValidator(config, new BitcoinManager(config));
    const result = await validator.validate({ sourceDid: 'did:webvh:example.com:a', targetLayer: 'btco' });
    expect(result.warnings.map(w => w.code)).toContain('FEE_ESTIMATION_FAILED');
  });

  test('[boundary] higher feeRate produces proportionally larger network fee estimate', async () => {
    const provider = new MockOrdinalsProvider();
    const config = { ...baseConfig, network: 'mainnet', ordinalsProvider: provider } as OriginalsConfig;
    const manager = new BitcoinManager(config);
    const validator = new BitcoinValidator(config, manager);

    const result5 = await validator.validate({
      sourceDid: 'did:webvh:example.com:asset1',
      targetLayer: 'btco',
      feeRate: 5,
    });
    const result20 = await validator.validate({
      sourceDid: 'did:webvh:example.com:asset1',
      targetLayer: 'btco',
      feeRate: 20,
    });

    expect(result20.estimatedCost.networkFees).toBeGreaterThan(result5.estimatedCost.networkFees);
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-037 — StateTracker: records state changes
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-037: StateTracker migration state recording', () => {
  let stateTracker: StateTracker;

  beforeEach(() => {
    stateTracker = new StateTracker(baseConfig);
  });

  test('[happy] createMigration creates state with PENDING status', async () => {
    const state = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkTrackerTest',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    expect(state.migrationId).toMatch(/^mig_/);
    expect(state.state).toBe(MigrationStateEnum.PENDING);
    expect(state.sourceDid).toBe('did:peer:z6MkTrackerTest');
    expect(state.sourceLayer).toBe('peer');
    expect(state.targetLayer).toBe('webvh');
    expect(state.progress).toBe(0);
    expect(state.startTime).toBeGreaterThan(0);
  });

  test('[happy] updateState transitions state correctly', async () => {
    const initial = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkTrackerUpdate',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    await stateTracker.updateState(initial.migrationId, {
      state: MigrationStateEnum.VALIDATING,
      progress: 10,
      currentOperation: 'Validating...',
    });

    const updated = await stateTracker.getState(initial.migrationId);
    expect(updated).not.toBeNull();
    expect(updated!.state).toBe(MigrationStateEnum.VALIDATING);
    expect(updated!.progress).toBe(10);
    expect(updated!.currentOperation).toBe('Validating...');
  });

  test('[happy] terminal COMPLETED state gets endTime set automatically', async () => {
    const state = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkTerminal',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    // Walk to COMPLETED via valid transitions
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.VALIDATING });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.CHECKPOINTED });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.IN_PROGRESS });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.COMPLETED });

    const final = await stateTracker.getState(state.migrationId);
    expect(final!.state).toBe(MigrationStateEnum.COMPLETED);
    expect(final!.endTime).toBeGreaterThan(0);
  });

  test('getActiveMigrations includes all non-terminal states, not just IN_PROGRESS (#293)', async () => {
    const advance = async (id: string, target: MigrationStateEnum) => {
      const chain = [
        MigrationStateEnum.VALIDATING,
        MigrationStateEnum.CHECKPOINTED,
        MigrationStateEnum.IN_PROGRESS,
        MigrationStateEnum.ANCHORING,
        MigrationStateEnum.COMPLETED
      ];
      for (const st of chain) {
        await stateTracker.updateState(id, { state: st });
        if (st === target) return;
      }
    };
    const pending = await stateTracker.createMigration({ sourceDid: 'did:peer:zActPending', targetLayer: 'webvh', domain: 'example.com' });
    const validating = await stateTracker.createMigration({ sourceDid: 'did:peer:zActValidating', targetLayer: 'webvh', domain: 'example.com' });
    const anchoring = await stateTracker.createMigration({ sourceDid: 'did:peer:zActAnchoring', targetLayer: 'btco' });
    const completed = await stateTracker.createMigration({ sourceDid: 'did:peer:zActCompleted', targetLayer: 'webvh', domain: 'example.com' });
    await advance(validating.migrationId, MigrationStateEnum.VALIDATING);
    await advance(anchoring.migrationId, MigrationStateEnum.ANCHORING);
    await advance(completed.migrationId, MigrationStateEnum.COMPLETED);

    const active = await stateTracker.getActiveMigrations();
    const ids = active.map(a => a.migrationId);
    // PENDING, VALIDATING and (notably) ANCHORING are active...
    expect(ids).toContain(pending.migrationId);
    expect(ids).toContain(validating.migrationId);
    expect(ids).toContain(anchoring.migrationId);
    // ...COMPLETED (terminal) is not.
    expect(ids).not.toContain(completed.migrationId);
  });

  test('[happy] queryStates filters by state correctly', async () => {
    const s1 = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkQuery1',
      targetLayer: 'webvh',
      domain: 'example.com',
    });
    const s2 = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkQuery2',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    await stateTracker.updateState(s2.migrationId, { state: MigrationStateEnum.VALIDATING });

    const pending = await stateTracker.queryStates({ state: MigrationStateEnum.PENDING });
    const pendingIds = pending.map(s => s.migrationId);
    expect(pendingIds).toContain(s1.migrationId);
    expect(pendingIds).not.toContain(s2.migrationId);
  });

  test('[error] updateState throws for invalid state transition (PENDING → COMPLETED)', async () => {
    const state = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkInvalidTransition',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    // PENDING → COMPLETED skips required intermediate states
    await expect(
      stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.COMPLETED })
    ).rejects.toThrow(/Invalid state transition/);
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-038 — StateTracker: cleanup old migration states
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-038: StateTracker.cleanupOldStates', () => {
  let stateTracker: StateTracker;

  beforeEach(() => {
    stateTracker = new StateTracker(baseConfig);
  });

  test('[happy] cleanup removes COMPLETED states older than retention window', async () => {
    const state = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkOldState',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    // Walk the state to COMPLETED
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.VALIDATING });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.CHECKPOINTED });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.IN_PROGRESS });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.COMPLETED });

    // Backdate endTime to be older than the retention window
    const privateStates: Map<string, any> = (stateTracker as any).states;
    const current = privateStates.get(state.migrationId);
    privateStates.set(state.migrationId, {
      ...current,
      endTime: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
    });

    await stateTracker.cleanupOldStates(7 * 24 * 60 * 60 * 1000);

    const afterCleanup = await stateTracker.getState(state.migrationId);
    expect(afterCleanup).toBeNull();
  });

  test('[boundary] cleanup preserves COMPLETED states within retention window', async () => {
    const state = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkRecentState',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.VALIDATING });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.CHECKPOINTED });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.IN_PROGRESS });
    await stateTracker.updateState(state.migrationId, { state: MigrationStateEnum.COMPLETED });

    // endTime is set to now — well within 7-day retention
    await stateTracker.cleanupOldStates(7 * 24 * 60 * 60 * 1000);

    const afterCleanup = await stateTracker.getState(state.migrationId);
    expect(afterCleanup).not.toBeNull();
    expect(afterCleanup!.state).toBe(MigrationStateEnum.COMPLETED);
  });

  test('[boundary] cleanup does not remove PENDING states even when old', async () => {
    const state = await stateTracker.createMigration({
      sourceDid: 'did:peer:z6MkActiveOld',
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    // Backdate startTime but leave state as PENDING (no endTime set)
    const privateStates: Map<string, any> = (stateTracker as any).states;
    privateStates.set(state.migrationId, {
      ...privateStates.get(state.migrationId),
      startTime: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
      // No endTime — active/pending
    });

    await stateTracker.cleanupOldStates(7 * 24 * 60 * 60 * 1000);

    // PENDING state without endTime should NOT be cleaned up
    const afterCleanup = await stateTracker.getState(state.migrationId);
    expect(afterCleanup).not.toBeNull();
    expect(afterCleanup!.state).toBe(MigrationStateEnum.PENDING);
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-039 — Peer→WebVH migration preserves resources
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-039: Peer→WebVH migration preserves asset resources', () => {
  afterEach(() => {
    MigrationManager.resetInstance();
  });

  test('[happy] LifecycleManager.publishToWeb preserves all asset resources after migration', async () => {
    const sdk = OriginalsSDK.create({ ...baseConfig });
    const resources = [
      { id: 'img-1', type: 'Image', contentType: 'image/png', hash: 'a5c741c7dea3a96944022b4b9a0b1480cfbeef5f4cc934850e8afacb48e18c5e', content: 'imgdata' },
      { id: 'doc-1', type: 'Document', contentType: 'application/pdf', hash: 'aef55fef7217f696b6624c1770f9e955a4d9f90d9e9261119e301c1309e2fd99', content: 'docdata' },
    ];

    const asset = await sdk.lifecycle.createAsset(resources);
    expect(asset.resources).toHaveLength(2);

    const peerDid = await sdk.did.createDIDPeer(resources);
    const webvhDid = (await sdk.did.migrateToDIDWebVH(peerDid, 'example.com')).didDocument;

    const published = await sdk.lifecycle.publishToWeb(asset, webvhDid.id);

    expect(published.resources).toHaveLength(2);
    expect(published.resources.map((r: any) => r.id)).toContain('img-1');
    expect(published.resources.map((r: any) => r.id)).toContain('doc-1');
    expect(published.currentLayer).toBe('did:webvh');
  });

  test('[happy] MigrationManager peer→webvh records correct source and target DIDs', async () => {
    MigrationManager.resetInstance();
    const sdk = OriginalsSDK.create({ ...baseConfig });
    const migrationManager = MigrationManager.getInstance(
      (sdk as any).config,
      sdk.did,
      sdk.credentials
    );

    const peerDid = await sdk.did.createDIDPeer(sampleResources);

    const result = await migrationManager.migrate({
      sourceDid: peerDid.id,
      targetLayer: 'webvh',
      domain: 'example.com',
    });

    expect(result.success).toBe(true);
    expect(result.targetDid).toBeDefined();
    expect(result.targetDid).toMatch(/did:webvh:/);
    expect(result.sourceDid).toBe(peerDid.id);
    expect(result.sourceLayer).toBe('peer');
    expect(result.targetLayer).toBe('webvh');
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-040 — WebVH→Bitcoin migration
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-040: WebVH→Bitcoin migration via LifecycleManager', () => {
  test('[happy] inscribeOnBitcoin returns inscriptionId in provenance', async () => {
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);

    const asset = await sdk.lifecycle.createAsset(sampleResources);
    const peerDid = await sdk.did.createDIDPeer(sampleResources);
    const webvhDid = (await sdk.did.migrateToDIDWebVH(peerDid, 'example.com')).didDocument;
    await sdk.lifecycle.publishToWeb(asset, webvhDid.id);

    const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset);

    expect(inscribed.currentLayer).toBe('did:btco');
    const prov = inscribed.getProvenance();
    const lastMig = prov.migrations[prov.migrations.length - 1];
    expect(lastMig.inscriptionId).toBeTruthy();
    expect(lastMig.to).toBe('did:btco');
  });

  test('[boundary] inscribeOnBitcoin respects explicit feeRate parameter', async () => {
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);

    const asset = await sdk.lifecycle.createAsset(sampleResources);
    const peerDid = await sdk.did.createDIDPeer(sampleResources);
    const webvhDid = (await sdk.did.migrateToDIDWebVH(peerDid, 'example.com')).didDocument;
    await sdk.lifecycle.publishToWeb(asset, webvhDid.id);

    const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset, 25);

    expect(inscribed.currentLayer).toBe('did:btco');
    const prov = inscribed.getProvenance();
    const lastMig = prov.migrations[prov.migrations.length - 1];
    // MockOrdinalsProvider echoes the feeRate back from createInscription params
    expect(lastMig.feeRate).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-041 — Peer→Bitcoin direct migration
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-041: Peer→Bitcoin direct migration', () => {
  afterEach(() => {
    MigrationManager.resetInstance();
  });

  test('[happy] direct peer→btco migration succeeds via LifecycleManager', async () => {
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);

    const asset = await sdk.lifecycle.createAsset(sampleResources);
    expect(asset.currentLayer).toBe('did:cel');

    const inscribed = await sdk.lifecycle.inscribeOnBitcoin(asset, 10);

    expect(inscribed.currentLayer).toBe('did:btco');
    const prov = inscribed.getProvenance();
    const lastMig = prov.migrations[prov.migrations.length - 1];
    expect(lastMig.from).toBe('did:cel');
    expect(lastMig.to).toBe('did:btco');
  });

  test('[happy] MigrationManager peer→btco creates a did:btco DID', async () => {
    MigrationManager.resetInstance();
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);
    const bitcoinManager = new BitcoinManager({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);
    const migrationManager = MigrationManager.getInstance(
      (sdk as any).config,
      sdk.did,
      sdk.credentials,
      bitcoinManager
    );

    const peerDid = await sdk.did.createDIDPeer(sampleResources);

    const result = await migrationManager.migrate({
      sourceDid: peerDid.id,
      targetLayer: 'btco',
    });

    expect(result.success).toBe(true);
    expect(result.targetDid).toMatch(/did:btco:/);
    expect(result.sourceLayer).toBe('peer');
    expect(result.targetLayer).toBe('btco');
  });

  test('[happy] MigrationManager peer→btco does NOT produce a webvh intermediate targetDid', async () => {
    // PeerToBtcoMigration takes the direct path — no webvh intermediate.
    MigrationManager.resetInstance();
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);
    const bitcoinManager = new BitcoinManager({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);
    const migrationManager = MigrationManager.getInstance(
      (sdk as any).config,
      sdk.did,
      sdk.credentials,
      bitcoinManager
    );

    const peerDid = await sdk.did.createDIDPeer(sampleResources);

    const result = await migrationManager.migrate({
      sourceDid: peerDid.id,
      targetLayer: 'btco',
    });

    expect(result.targetDid).not.toMatch(/did:webvh:/);
    expect(result.targetDid).toMatch(/did:btco:/);
  });
});

// ---------------------------------------------------------------------------
// CORE-MIG-EVENTS-042 — Cost estimation for webvh→btco includes Bitcoin fees
// ---------------------------------------------------------------------------

describe.skip('CORE-MIG-EVENTS-042: Cost estimation webvh→btco includes Bitcoin fees', () => {
  afterEach(() => {
    MigrationManager.resetInstance();
  });

  test('[happy] estimateMigrationCost for webvh→btco returns non-zero networkFees', async () => {
    MigrationManager.resetInstance();
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);
    const bitcoinManager = new BitcoinManager({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);
    const migrationManager = MigrationManager.getInstance(
      (sdk as any).config,
      sdk.did,
      sdk.credentials,
      bitcoinManager
    );

    const peerDid = await sdk.did.createDIDPeer(sampleResources);
    const webvhDid = (await sdk.did.migrateToDIDWebVH(peerDid, 'example.com')).didDocument;

    const cost = await migrationManager.estimateMigrationCost(webvhDid.id, 'btco', 10);

    expect(cost.networkFees).toBeGreaterThan(0);
    expect(cost.totalCost).toBeGreaterThan(0);
    expect(cost.currency).toBe('sats');
  });

  test('[boundary] webvh→btco higher feeRate produces larger cost estimate', async () => {
    MigrationManager.resetInstance();
    const provider = new MockOrdinalsProvider();
    const sdk = OriginalsSDK.create({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);
    const bitcoinManager = new BitcoinManager({
      ...baseConfig,
      ordinalsProvider: provider,
    } as any);
    const migrationManager = MigrationManager.getInstance(
      (sdk as any).config,
      sdk.did,
      sdk.credentials,
      bitcoinManager
    );

    const peerDid = await sdk.did.createDIDPeer(sampleResources);
    const webvhDid = (await sdk.did.migrateToDIDWebVH(peerDid, 'example.com')).didDocument;

    const costLow = await migrationManager.estimateMigrationCost(webvhDid.id, 'btco', 5);
    const costHigh = await migrationManager.estimateMigrationCost(webvhDid.id, 'btco', 50);

    expect(costHigh.networkFees).toBeGreaterThan(costLow.networkFees);
  });

  test('[happy] peer→webvh cost estimation returns zero networkFees', async () => {
    MigrationManager.resetInstance();
    const sdk = OriginalsSDK.create({ ...baseConfig });
    const migrationManager = MigrationManager.getInstance(
      (sdk as any).config,
      sdk.did,
      sdk.credentials
    );

    const peerDid = await sdk.did.createDIDPeer(sampleResources);

    const cost = await migrationManager.estimateMigrationCost(peerDid.id, 'webvh');

    // WebVH migration incurs no Bitcoin network fees
    expect(cost.networkFees).toBe(0);
    expect(cost.currency).toBe('sats');
  });
});
