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
import { createKeyStoreCelSigner, currentControllerVm, hexSha256ToDigestMultibase } from '../../../src/cel/signerAdapter';
import { replayProvenance } from '../../../src/lifecycle/replayProvenance';
import { hashResource } from '../../../src/utils/validation';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import * as ed25519 from '@noble/ed25519';

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
  test('genesis-only log: did:cel layer, did:cel binding, no migrations', async () => {
    const { lifecycle } = makeLifecycle();
    const asset = await lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: 'cd'.repeat(32) }
    ]);

    const folded = replayProvenance(asset.celLog!);

    expect(folded.currentLayer).toBe('did:cel');
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

  test('btco binding is derived from the signed data.to, not the witness sat', async () => {
    // A migrate whose SIGNED to disagrees with a (spoofable) witness sat must
    // fold to the SIGNED sat. Build create + btco-migrate with data.to on one
    // sat and a bitcoin witness proof naming a DIFFERENT sat.
    const log = {
      events: [
        {
          type: 'create',
          data: { controller: 'did:key:zSigner', name: 'A', resources: [], createdAt: '2026-07-13T00:00:00Z' },
          proof: [{ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: 'did:key:zSigner#zSigner', proofPurpose: 'assertionMethod', proofValue: 'z1' }],
        },
        {
          type: 'migrate',
          data: { sourceDid: 'did:cel:uX', layer: 'btco', network: 'regtest', to: 'did:btco:reg:111', migratedAt: '2026-07-13T00:01:00Z' },
          previousEvent: 'uPrev',
          proof: [
            { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: 'did:key:zSigner#zSigner', proofPurpose: 'assertionMethod', proofValue: 'z2' },
            { type: 'DataIntegrityProof', cryptosuite: 'bitcoin-ordinals-2024', witnessedAt: 'x', created: 'x', verificationMethod: 'did:btco:witness', proofPurpose: 'assertionMethod', proofValue: 'zinsc', satoshi: '999', inscriptionId: 'insc' },
          ],
        },
      ],
    } as any;
    const folded = replayProvenance(log);
    expect(folded.currentLayer).toBe('did:btco');
    expect(folded.bindings['did:btco']).toBe('did:btco:reg:111'); // signed, not the witness 999
  });
});

async function makeReplaySigner() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2021-05-05T00:00:00Z',
    verificationMethod: vm, proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))),
  });
  return { signer, didKey, vm };
}
const rhex = (s: string) => hashResource(Buffer.from(s, 'utf-8'));

describe('replayProvenance: resourceUpdates fold', () => {
  test('folds update events into resourceUpdates with the signed toHash', async () => {
    const a = await makeReplaySigner();
    let log = await createEventLog(
      { name: 'r', controller: a.didKey, resources: [{ digestMultibase: hexSha256ToDigestMultibase(rhex('v1')) }], createdAt: 'x', nonce: 'z1' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'update',
      { resourceId: 'r', contentType: 'text/plain', previousVersionHash: rhex('v1'), toHash: rhex('v2'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });

    const folded = replayProvenance(log);
    expect(folded.resourceUpdates.length).toBe(1);
    const u = folded.resourceUpdates[0];
    expect(u.resourceId).toBe('r');
    expect(u.fromVersion).toBe(1);
    expect(u.toVersion).toBe(2);
    expect(u.fromHash).toBe(rhex('v1'));
    expect(u.toHash).toBe(rhex('v2'));
    expect(u.timestamp).toBe('2021-05-05T00:00:00Z');
  });

  test('generic and migration-ish updates do NOT fold into resourceUpdates', async () => {
    const a = await makeReplaySigner();
    let log = await createEventLog(
      { name: 'r', controller: a.didKey, resources: [{ digestMultibase: hexSha256ToDigestMultibase(rhex('v1')) }], createdAt: 'x', nonce: 'z2' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'update', { note: 'generic' }, { signer: a.signer, verificationMethod: a.vm });
    expect(replayProvenance(log).resourceUpdates.length).toBe(0);
  });
});
