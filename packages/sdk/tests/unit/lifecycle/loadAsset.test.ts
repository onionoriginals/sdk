/**
 * Phase-3 Task 2: loadAsset + OriginalsAsset.restore + genesis-binding extraction.
 *
 * The buyer half of #377: serialize() encodes an asset into an AssetEnvelope;
 * loadAsset() parses it, VERIFIES BY DEFAULT, cross-checks, folds, and rebuilds
 * the asset via the @internal OriginalsAsset.restore() factory.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { hashResource } from '../../../src/utils/validation';
import { checkGenesisResourceBinding } from '../../../src/lifecycle/genesisBinding';
import type { AssetEnvelope } from '../../../src/lifecycle/assetEnvelope';

const NEW_OWNER = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

function makeSDK() {
  const ordinalsProvider = new OrdMockProvider();
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore: new MockKeyStore()
  });
  return { sdk, ordinalsProvider };
}

async function createGenesisAsset(sdk: OriginalsSDK) {
  return sdk.lifecycle.createAsset([
    { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
  ]);
}

describe('loadAsset — round-trip', () => {
  test('create -> publish -> inscribe -> transfer, serialize -> loadAsset (same manager): verified, provenance parity, no asset:migrated during load', async () => {
    const { sdk } = makeSDK();

    const asset = await createGenesisAsset(sdk);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    await sdk.lifecycle.transferOwnership(asset, NEW_OWNER);

    const envelope = asset.serialize();

    // Subscribe on the manager emitter: loadAsset must not drive asset.migrate.
    let migratedDuringLoad = 0;
    const off = sdk.lifecycle.on('asset:migrated', () => { migratedDuringLoad++; });

    const { asset: loaded, verification, warnings } = await sdk.lifecycle.loadAsset(envelope);

    // let any deferred emits flush
    await new Promise(r => setTimeout(r, 0));
    off();

    expect(migratedDuringLoad).toBe(0);
    expect(verification?.verified).toBe(true);
    expect(warnings).toEqual([]);

    // Identity + layer restored (ctor would have derived 'did:peer' for did:cel).
    expect(loaded.id).toBe(asset.id);
    expect(loaded.currentLayer).toBe('did:btco');
    expect(loaded.currentLayer).toBe(asset.currentLayer);

    // Bindings folded from the log, parity with the live cache.
    expect(loaded.bindings).toEqual(asset.bindings);

    // Provenance parity on the reconstructable dimensions.
    const lp = loaded.getProvenance();
    const op = asset.getProvenance();
    expect(lp.migrations.map(m => [m.from, m.to])).toEqual(op.migrations.map(m => [m.from, m.to]));
    const lBtco = lp.migrations.find(m => m.to === 'did:btco')!;
    const oBtco = op.migrations.find(m => m.to === 'did:btco')!;
    expect(lBtco.satoshi).toBe(oBtco.satoshi);
    expect(lBtco.inscriptionId).toBe(oBtco.inscriptionId);
    expect(lBtco.commitTxId).toBe(oBtco.commitTxId);
    expect(lBtco.feeRate).toBe(oBtco.feeRate);
    // Ownership history is the sat's UTXO chain, not the CEL — a transfer is a
    // pure sat move that appends nothing, so provenance carries no transfers and
    // txid stays at the btco migration's reveal txid on both live and restored.
    expect(lp.txid).toBe(op.txid);
    expect(lp.txid).toBe(oBtco.transactionId);

    // The loaded asset re-verifies on its own.
    expect(await loaded.verify({ ordinalsProvider: (sdk as any).config?.ordinalsProvider })).toBe(true);
  });

  test('genesis-only asset round-trips (currentLayer did:peer)', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    const { asset: loaded, verification } = await sdk.lifecycle.loadAsset(envelope);
    expect(verification?.verified).toBe(true);
    expect(loaded.currentLayer).toBe('did:peer');
    expect(loaded.id).toBe(asset.id);
    expect(loaded.bindings).toEqual({ 'did:cel': asset.id });
  });

  test('accepts a JSON string envelope', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const json = JSON.stringify(asset.serialize());
    const { asset: loaded, verification } = await sdk.lifecycle.loadAsset(json);
    expect(verification?.verified).toBe(true);
    expect(loaded.id).toBe(asset.id);
  });
});

describe('loadAsset — fail-closed verification', () => {
  test('tampered genesis event -> ASSET_LOAD_VERIFICATION_FAILED carrying the VerificationResult', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    (envelope.eventLog.events[0].data as { name?: string }).name = 'tampered';

    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
    expect(err.details?.verification).toBeDefined();
    expect(err.details.verification.verified).toBe(false);
  });

  test('version 2 envelope -> ENVELOPE_VERSION_UNSUPPORTED', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = { ...asset.serialize(), version: 2 } as AssetEnvelope;
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    expect(err?.code).toBe('ENVELOPE_VERSION_UNSUPPORTED');
  });

  test('swapped did:webvh doc -> fails load', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const envelope = asset.serialize();
    // Swap the captured webvh doc id for a different did:webvh — the fold's
    // binding (from the signed migrate event) no longer matches it.
    envelope.didDocuments['did:webvh']!.id = 'did:webvh:deadbeef:evil.com';
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    expect(err?.code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
  });

  test('missing genesis resource -> fails load', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    // Non-empty resources, but the genesis digest is no longer present.
    envelope.resources[0].hash = 'cd'.repeat(32);
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    expect(err?.code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
  });

  test('tampered inline content with honest hash -> fails load', async () => {
    const { sdk } = makeSDK();
    const content = 'hello world';
    const hash = hashResource(Buffer.from(content, 'utf8'));
    const asset = await sdk.lifecycle.createAsset([
      { id: 'doc', type: 'text', content, contentType: 'text/plain', hash }
    ]);
    const envelope = asset.serialize();
    // Keep the honest hash (genesis binding still passes) but tamper the bytes.
    envelope.resources[0].content = 'goodbye world';
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    expect(err?.code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
  });
});

describe('loadAsset — skipVerification', () => {
  test('returns asset with verification absent, and still loads a tampered log', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    (envelope.eventLog.events[0].data as { name?: string }).name = 'tampered';

    const { asset: loaded, verification } = await sdk.lifecycle.loadAsset(envelope, { skipVerification: true });
    expect(verification).toBeUndefined();
    expect(loaded.id).toBe(asset.id);
  });

  test('structural validation still runs: bad format throws', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = { ...asset.serialize(), format: 'wrong' } as unknown as AssetEnvelope;
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope, { skipVerification: true }); } catch (e) { err = e; }
    expect(err).toBeDefined();
  });

  test('structural validation still runs: version 2 throws ENVELOPE_VERSION_UNSUPPORTED', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = { ...asset.serialize(), version: 2 } as AssetEnvelope;
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope, { skipVerification: true }); } catch (e) { err = e; }
    expect(err?.code).toBe('ENVELOPE_VERSION_UNSUPPORTED');
  });
});

describe('loadAsset — captured DID document repopulation', () => {
  test('re-serializing a loaded asset carries forward the same webvh and btco docs', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const envelope = asset.serialize();
    const { asset: loaded } = await sdk.lifecycle.loadAsset(envelope);
    const reserialized = loaded.serialize();

    expect(reserialized.didDocuments['did:webvh']).toEqual(envelope.didDocuments['did:webvh']);
    expect(reserialized.didDocuments['did:btco']).toEqual(envelope.didDocuments['did:btco']);
  });

  test('degraded btco binding (no witness proof) is not repopulated on re-serialize', async () => {
    // No keyStore → the btco migrate event never lands in the log, so the fold
    // can't derive did:btco even though the live cache (and envelope) has it.
    const ordinalsProvider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: new MemoryStorageAdapter()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const envelope = asset.serialize();
    expect(envelope.didDocuments['did:btco']).toBeDefined();
    expect(envelope.unverified?.bindings?.['did:btco']).toBeDefined();

    const { asset: loaded } = await sdk.lifecycle.loadAsset(envelope);
    const reserialized = loaded.serialize();

    expect(reserialized.didDocuments['did:btco']).toBeUndefined();
  });
});

describe('loadAsset — did:cel doc is DERIVED from the verified log, not trusted', () => {
  test('tampered did:cel VM[0] + rogue service are ignored: asset.did carries the genuine genesis key and no rogue service', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    const genuineKey = envelope.didDocuments['did:cel'].verificationMethod![0].publicKeyMultibase;

    // Tamper: swap VM[0] to an attacker key + inject rogue service endpoints.
    envelope.didDocuments['did:cel'].verificationMethod![0].publicKeyMultibase =
      'z6MkspoJoTNRrjXk4fWjZgVCyxysPnaMFDafFkPQxvBhwjNb';
    (envelope.didDocuments['did:cel'] as any).service = [
      { id: `${asset.id}#evil`, type: 'Attacker', serviceEndpoint: 'https://evil.example' }
    ];

    const { asset: loaded } = await sdk.lifecycle.loadAsset(envelope);
    expect(loaded.id).toBe(envelope.assetDid);
    expect(loaded.did.verificationMethod![0].publicKeyMultibase).toBe(genuineKey);
    expect((loaded.did as any).service).toBeUndefined();
  });

  test('swapped did:cel doc id is ignored: loaded asset.id is the derived/verified did:cel', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    envelope.didDocuments['did:cel'].id = 'did:cel:uEVILEVILEVIL';
    const { asset: loaded } = await sdk.lifecycle.loadAsset(envelope);
    expect(loaded.id).toBe(envelope.assetDid);
    expect(loaded.did.id).toBe(envelope.assetDid);
  });
});

describe('loadAsset — envelope credentials are validated, not trusted', () => {
  test('non-array credentials -> ENVELOPE_INVALID', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    (envelope as any).credentials = { not: 'an array' };
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    expect(err?.code).toBe('ENVELOPE_INVALID');
  });

  test('forged credential proof -> fails load (issuer resolves) or loads with a warning naming the credential', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const envelope = asset.serialize();
    expect((envelope.credentials?.length ?? 0)).toBeGreaterThan(0);
    const cred: any = envelope.credentials![0];
    const proof = Array.isArray(cred.proof) ? cred.proof[0] : cred.proof;
    proof.proofValue = 'z' + 'A'.repeat(80);

    let err: any; let res: any;
    try { res = await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    if (err) {
      expect(err.code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
    } else {
      expect(res.warnings.some((w: string) => /credential/i.test(w))).toBe(true);
    }
  });

  test('structurally invalid credential -> ASSET_LOAD_VERIFICATION_FAILED (even under skipVerification)', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    (envelope as any).credentials = [{ '@context': ['nope'], type: ['NotACredential'] }];
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope, { skipVerification: true }); } catch (e) { err = e; }
    expect(err?.code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
  });
});

describe('loadAsset — malformed envelope taxonomy', () => {
  test('resource with non-string hash -> ENVELOPE_INVALID (not a raw TypeError)', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    delete (envelope.resources[0] as any).hash;
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    expect(err?.code).toBe('ENVELOPE_INVALID');
  });

  test('non-create-first log -> ENVELOPE_INVALID (not a raw Error)', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const envelope = asset.serialize();
    // Drop the create event so the first event is no longer a create.
    envelope.eventLog.events = envelope.eventLog.events.slice(1);
    if (envelope.eventLog.events.length === 0) {
      envelope.eventLog.events = [{ type: 'transfer', data: {}, proof: [] } as any];
    }
    let err: any;
    try { await sdk.lifecycle.loadAsset(envelope); } catch (e) { err = e; }
    expect(['ENVELOPE_INVALID', 'ASSET_LOAD_VERIFICATION_FAILED']).toContain(err?.code);
  });
});

describe('checkGenesisResourceBinding (extracted pure helper)', () => {
  test('returns true when every genesis digest is present among resources', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    expect(checkGenesisResourceBinding(asset.celLog!, asset.resources)).toBe(true);
  });

  test('returns false when a genesis digest is missing', async () => {
    const { sdk } = makeSDK();
    const asset = await createGenesisAsset(sdk);
    const swapped = asset.resources.map(r => ({ ...r, hash: 'cd'.repeat(32) }));
    expect(checkGenesisResourceBinding(asset.celLog!, swapped)).toBe(false);
  });

  test('legacy-shaped genesis (data.did, no resources array) passes', () => {
    const legacyLog = {
      events: [{ type: 'create' as const, data: { did: 'did:peer:xyz', name: 'x' }, proof: [] as any[] }]
    };
    expect(checkGenesisResourceBinding(legacyLog as any, [])).toBe(true);
  });
});
