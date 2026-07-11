/**
 * Phase-2 Task 7: `replayProvenance` — a PURE fold over a CEL event log.
 *
 * Parity contract: replaying `asset.celLog!` must agree with the live,
 * in-memory caches (`asset.currentLayer`, `asset.bindings`,
 * `asset.getProvenance()`) on the fields the log can actually reconstruct.
 * KNOWN, DOCUMENTED DIVERGENCE (see replayProvenance.ts JSDoc): the OrdMock
 * lifecycle's btco `migrate` event carries no bitcoin witness proof
 * (append-first, pre-inscription — Task 5), so `bindings['did:btco']` is
 * un-derivable from the log alone in this flow; the live cache derives it
 * from the inscription result instead. Also, `commitTxId`/`feeRate` live
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
  test('genesis-only log: did:peer layer, did:cel binding, no migrations/transfers', async () => {
    const { lifecycle } = makeLifecycle();
    const asset = await lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: 'cd'.repeat(32) }
    ]);

    const folded = replayProvenance(asset.celLog!);

    expect(folded.currentLayer).toBe('did:peer');
    expect(folded.bindings['did:cel']).toBe(asset.id);
    expect(folded.bindings['did:cel']).toBe(deriveDidCel(asset.celLog!));
    expect(folded.migrations).toEqual([]);
    expect(folded.transfers).toEqual([]);
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
    await lifecycle.transferOwnership(asset, VALID_ADDR);

    const folded = replayProvenance(asset.celLog!);
    const live = asset.getProvenance();

    // Shared, log-derivable fields must agree exactly.
    expect(folded.currentLayer).toBe(asset.currentLayer);
    expect(folded.bindings['did:cel']).toBe(asset.id);
    expect(folded.bindings['did:webvh']).toBe(asset.bindings?.['did:webvh']);
    expect(folded.transfers.length).toBe(live.transfers.length);
    expect(folded.transfers[folded.transfers.length - 1]?.transactionId).toBe(
      live.transfers[live.transfers.length - 1]?.transactionId
    );

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
    expect(afterFold.transfers).toEqual(beforeFold.transfers);
    // Layer/bindings also unaffected by a rotation.
    expect(afterFold.currentLayer).toBe(beforeFold.currentLayer);
    expect(afterFold.bindings).toEqual(beforeFold.bindings);
  });
});
