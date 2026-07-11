/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { deriveDidCel } from '../../../src/cel/celDid';
import { currentControllerVm } from '../../../src/cel/signerAdapter';

const TO_ADDRESS = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

describe('LifecycleManager.transferOwnership unit edge cases', () => {
  const provider = new MockOrdinalsProvider();
  const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

  test('throws if not on btco layer', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:domain:1' } as any,
      []
    );
    await expect(sdk.lifecycle.transferOwnership(asset as any, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).rejects.toThrow('Asset must be inscribed on Bitcoin before transfer');
  });

  test('succeeds and updates provenance when on btco', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:42' } as any,
      []
    );
    const tx = await sdk.lifecycle.transferOwnership(asset, 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
    expect(typeof tx.txid).toBe('string');
    expect(asset.getProvenance().transfers.length).toBe(1);
  });

  test('asset-emitter asset:transferred payload carries keyRotationPending (rotation-first #366)', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:43' } as any,
      []
    );
    const events: any[] = [];
    asset.on('asset:transferred', (e) => { events.push(e); });
    await sdk.lifecycle.transferOwnership(asset, 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
    expect(events.length).toBe(1);
    expect(events[0].keyRotationPending).toBe(true);
  });

  test('extracts satoshi network-blindly and resolves the real inscription (no migration record) (#273)', async () => {
    // Two regressions in one path:
    //  1. For `did:btco:reg:<sat>` the old `split(':')[2]` returned the network
    //     tag 'reg' instead of the satoshi.
    //  2. The inscription that backs the transfer must be looked up on the
    //     satoshi via the provider, NOT fabricated as `insc-<sat>` — otherwise a
    //     transfer records invented backing-transaction data.
    let lookedUpSatoshi: string | undefined;
    let capturedInscriptionId: string | undefined;
    const spyProvider = new MockOrdinalsProvider();
    const origBySat = spyProvider.getInscriptionsBySatoshi.bind(spyProvider);
    spyProvider.getInscriptionsBySatoshi = async (satoshi: string) => {
      lookedUpSatoshi = satoshi;
      return origBySat(satoshi);
    };
    const origTransfer = spyProvider.transferInscription.bind(spyProvider);
    spyProvider.transferInscription = async (inscriptionId: string, toAddress: string, options?: { feeRate?: number }) => {
      capturedInscriptionId = inscriptionId;
      return origTransfer(inscriptionId, toAddress, options);
    };
    const spySdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: spyProvider } as any);

    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:reg:123456' } as any,
      []
    );
    // Provenance has no migrations, so satoshi is derived from the DID.
    expect(asset.getProvenance().migrations.length).toBe(0);

    await spySdk.lifecycle.transferOwnership(asset, 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
    // Satoshi parsed network-aware: '123456', never the 'reg' network tag.
    expect(lookedUpSatoshi).toBe('123456');
    // The inscription id is the REAL one the provider reports for that satoshi,
    // not a fabricated `insc-123456` placeholder.
    expect(capturedInscriptionId).toBe('insc-mock');
  });

  test('throws INSCRIPTION_NOT_FOUND when no inscription backs the satoshi (#273)', async () => {
    // A did:btco asset with no migration record whose satoshi carries no
    // inscription must fail loudly rather than fabricate an `insc-<sat>` id and
    // write invented provenance.
    const emptyProvider = new MockOrdinalsProvider();
    emptyProvider.getInscriptionsBySatoshi = async () => [];
    const s = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: emptyProvider } as any);
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:reg:999999' } as any,
      []
    );
    await expect(
      s.lifecycle.transferOwnership(asset, 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7')
    ).rejects.toThrow('no inscription found on satoshi');
  });
});

describe('transferOwnership appends signed CEL transfer event (#Phase2 task 6)', () => {
  const makeSdk = (keyStore?: MockKeyStore, provider: OrdMockProvider = new OrdMockProvider()) =>
    OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      ...(keyStore ? { keyStore } : {})
    } as any);

  // did:cel asset carried all the way to did:btco so a transfer can append.
  const inscribedCelAsset = async (sdk: OriginalsSDK) => {
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    return asset;
  };

  test('appends a transfer event: last event type=transfer, data.txid=tx.txid, data.newOwner=address, log verifies', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(new MockKeyStore(), provider);
    const asset = await inscribedCelAsset(sdk);

    const tx = await sdk.lifecycle.transferOwnership(asset, TO_ADDRESS);

    const events = asset.celLog!.events;
    const last = events[events.length - 1];
    expect(last.type).toBe('transfer');
    expect((last.data as any).txid).toBe(tx.txid);
    expect((last.data as any).newOwner).toBe(TO_ADDRESS);
    // previousOwner is the outgoing controller's did:key (pre-#), folded from the log.
    expect(String((last.data as any).previousOwner).startsWith('did:key:')).toBe(true);

    // The btco migrate event carries a bitcoin witness proof (#367), so the
    // log verifies only against the chain — the provider is required.
    const result = await verifyEventLog(asset.celLog!, {
      expectedDid: deriveDidCel(asset.celLog!),
      ordinalsProvider: provider
    });
    expect(result.verified).toBe(true);
  });

  test('keyStore-less asset: transfer succeeds, cel:append-skipped emitted, no throw, provenance recorded', async () => {
    const sdk = makeSdk(); // no keyStore
    const skipped: string[] = [];
    sdk.lifecycle.on('cel:append-skipped', (e: any) => { skipped.push(e.reason); });
    const asset = await inscribedCelAsset(sdk);
    skipped.length = 0; // ignore the inscribe-time skip

    const before = asset.getProvenance().transfers.length;
    const tx = await sdk.lifecycle.transferOwnership(asset, TO_ADDRESS);

    expect(typeof tx.txid).toBe('string');
    expect(skipped).toEqual(['NO_KEYSTORE']);
    expect(asset.getProvenance().transfers.length).toBe(before + 1);
    // Degrade path leaves the log untouched (no transfer event appended).
    const events = asset.celLog!.events;
    expect(events[events.length - 1].type).not.toBe('transfer');
  });

  test('signer throws mid-append after the sat moved → CEL_APPEND_FAILED_POST_TRANSFER with txid; provenance not lost', async () => {
    const keyStore = new MockKeyStore();
    const sdk = makeSdk(keyStore);
    const asset = await inscribedCelAsset(sdk);

    // Corrupt the OUTGOING controller's key so the transfer append's signer
    // throws mid-sign (passes the never-had-it guard, then fails for real).
    const vm = currentControllerVm(asset.celLog!);
    await keyStore.setPrivateKey(vm, 'z-not-a-valid-multikey-private-key');

    const before = asset.getProvenance().transfers.length;
    let err: any;
    try {
      await sdk.lifecycle.transferOwnership(asset, TO_ADDRESS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('CEL_APPEND_FAILED_POST_TRANSFER');
    expect(err.details?.txid).toBeTruthy();
    // The tx happened, so in-memory provenance must still record the transfer.
    expect(asset.getProvenance().transfers.length).toBe(before + 1);
  });
});

