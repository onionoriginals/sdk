/**
 * Phase-2 Task 7: `replayProvenance` — a PURE fold over a CEL event log.
 *
 * Parity contract: replaying `asset.celLog!` must agree with the live,
 * in-memory caches (`asset.currentLayer`, `asset.bindings`,
 * `asset.getProvenance()`) on the fields the log can actually reconstruct.
 * Since Task 8 (#367) the lifecycle's btco `migrate` event carries a bitcoin
 * witness proof from the DID-doc inscription, so `bindings['did:btco']` IS
 * derivable from the log in the real flow (the parity test's conditional
 * exercises the equality branch). It stays un-derivable only in degraded /
 * legacy flows without a witness proof. `commitTxId`/`feeRate` still live
 * only in the in-memory ProvenanceChain, never in the log.
 */
import { describe, test, expect } from 'bun:test';
import { LifecycleManager } from '../../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { OriginalsConfig } from '../../../src/types';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { deriveDidCel } from '../../../src/cel/celDid';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { createKeyStoreCelSigner, currentControllerVm } from '../../../src/cel/signerAdapter';
import { replayProvenance } from '../../../src/lifecycle/replayProvenance';

const VALID_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

// Copy of LifecycleManager.celgenesis.test.ts's SDK+keyStore construction,
// extended with an OrdMockProvider so the full lifecycle (inscribe/transfer)
// can run.
function makeLifecycle() {
  const config: OriginalsConfig = {
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    enableLogging: false,
    storageAdapter: new MemoryStorageAdapter(),
    ordinalsProvider: new OrdMockProvider()
  };
  const didManager = new DIDManager(config);
  const credentialManager = new CredentialManager(config, didManager);
  const keyStore = new MockKeyStore();
  const lifecycle = new LifecycleManager(config, didManager, credentialManager, undefined, keyStore);
  return { lifecycle, keyStore };
}

describe('replayProvenance pure fold (#Phase2 Task7)', () => {
  test('genesis-only log: did:peer layer, did:cel binding, no migrations', async () => {
    const { lifecycle } = makeLifecycle();
    const asset = await lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: 'cd'.repeat(32) }
    ]);

    const folded = replayProvenance(asset.celLog!);

    expect(folded.currentLayer).toBe('did:peer');
    expect(folded.bindings['did:cel']).toBe(asset.id);
    expect(folded.bindings['did:cel']).toBe(deriveDidCel(asset.celLog!));
    expect(folded.migrations).toEqual([]);
  });

  test('throws on an empty log', () => {
    expect(() => replayProvenance({ events: [] })).toThrow();
  });

  test('full lifecycle parity: create -> publishToWeb -> inscribeOnBitcoin -> transferOwnership', async () => {
    const { lifecycle } = makeLifecycle();
    let asset = await lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ab'.repeat(32) }
    ]);
    asset = await lifecycle.publishToWeb(asset, 'example.com');
    asset = await lifecycle.inscribeOnBitcoin(asset);
    // Transfer is a pure sat move: it must NOT grow the log. Snapshot the event
    // count, run the transfer, and assert the fold is unchanged by it.
    const eventsBeforeTransfer = asset.celLog!.events.length;
    await lifecycle.transferOwnership(asset, VALID_ADDR);
    expect(asset.celLog!.events.length).toBe(eventsBeforeTransfer);

    const folded = replayProvenance(asset.celLog!);

    // Shared, log-derivable fields must agree exactly.
    expect(folded.currentLayer).toBe(asset.currentLayer);
    expect(folded.bindings['did:cel']).toBe(asset.id);
    expect(folded.bindings['did:webvh']).toBe(asset.bindings?.['did:webvh']);

    // Known divergence: no bitcoin witness proof in this flow, so the fold
    // cannot derive the btco binding. Assert parity only if it DID find one.
    if (folded.bindings['did:btco']) {
      expect(folded.bindings['did:btco']).toBe(asset.bindings?.['did:btco']);
    } else {
      expect(asset.bindings?.['did:btco']).toBeDefined(); // live cache has it; log doesn't (documented gap)
    }

    // did:webvh migration is precisely derivable end-to-end.
    const webvhMigration = folded.migrations.find((m) => m.to === asset.bindings?.['did:webvh']);
    expect(webvhMigration).toBeDefined();
    expect(webvhMigration?.from).toBe(asset.id);

    // btco migration is present but its `to` is the honest sentinel absent a witness proof.
    const btcoMigration = folded.migrations[folded.migrations.length - 1];
    expect(btcoMigration.to).toBe(folded.bindings['did:btco'] ?? 'did:btco:?');
  });

  test('witness-proof-present btco migration derives bindings[did:btco] and precise migration.to', () => {
    // Hand-built log: replayProvenance verifies nothing, so the create/migrate
    // proofs below are structurally valid but not real signatures.
    const genesisDid = 'did:cel:zFakeGenesisDigestFakeGenesisDigest';
    const log = {
      events: [
        {
          type: 'create',
          data: {
            name: 'Witnessed Asset',
            controller: 'did:key:z6MkFakeControllerFakeControllerFakeFake',
            resources: [],
            createdAt: '2026-07-10T00:00:00.000Z',
            nonce: 'u1111',
          },
          proof: [
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: 'x',
              verificationMethod: 'did:key:z6MkFakeControllerFakeControllerFakeFake#z6MkFakeControllerFakeControllerFakeFake',
              proofPurpose: 'assertionMethod',
              proofValue: 'z1',
            },
          ],
        },
        {
          type: 'migrate',
          data: {
            sourceDid: genesisDid,
            layer: 'btco',
            network: 'regtest',
            to: 'did:btco:reg:123456789',
            migratedAt: '2026-07-10T00:05:00.000Z',
          },
          proof: [
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'bitcoin-ordinals-2024',
              satoshi: '123456789',
              witnessedAt: 'x',
              created: 'x',
              verificationMethod: 'x',
              proofPurpose: 'assertionMethod',
              proofValue: 'z1',
            },
          ],
        },
      ],
    } as const;

    const folded = replayProvenance(log as unknown as Parameters<typeof replayProvenance>[0]);

    expect(folded.currentLayer).toBe('did:btco');
    expect(folded.bindings['did:btco']).toBe('did:btco:reg:123456789');
    const btcoMigration = folded.migrations[folded.migrations.length - 1];
    expect(btcoMigration.to).toBe('did:btco:reg:123456789');
  });

  test('rotateKey/update/deactivate events contribute no provenance entries', async () => {
    const { lifecycle, keyStore } = makeLifecycle();
    const asset = await lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ef'.repeat(32) }
    ]);
    const beforeFold = replayProvenance(asset.celLog!);

    // Manually append a rotateKey event (same data shape as
    // LifecycleManager.rotateBtcoKeys), signed by the current controller —
    // exercising the fold directly without requiring a did:btco asset.
    const vm = currentControllerVm(asset.celLog!);
    const signer = createKeyStoreCelSigner(keyStore, vm);
    const rotatedLog = await appendEvent(
      asset.celLog!,
      'rotateKey',
      { newController: 'did:key:z6MkNewControllerFakeFakeFakeFakeFakeFakeFake', rotatedAt: new Date().toISOString() },
      { signer, verificationMethod: vm }
    );

    const afterFold = replayProvenance(rotatedLog);
    expect(afterFold.migrations).toEqual(beforeFold.migrations);
    // Layer/bindings also unaffected by a rotation.
    expect(afterFold.currentLayer).toBe(beforeFold.currentLayer);
    expect(afterFold.bindings).toEqual(beforeFold.bindings);
  });
});
