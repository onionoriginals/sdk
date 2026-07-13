/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';

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

  test('succeeds on btco: returns a tx with txid (pure sat move)', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:42' } as any,
      []
    );
    const tx = await sdk.lifecycle.transferOwnership(asset, TO_ADDRESS);
    expect(typeof tx.txid).toBe('string');
    expect(tx.txid.length).toBeGreaterThan(0);
  });

  test('asset:transferred fires on BOTH emitters WITHOUT keyRotationPending', async () => {
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:43' } as any,
      []
    );
    const assetEvents: any[] = [];
    const managerEvents: any[] = [];
    asset.on('asset:transferred', (e) => { assetEvents.push(e); });
    sdk.lifecycle.on('asset:transferred', (e) => { managerEvents.push(e); });

    const tx = await sdk.lifecycle.transferOwnership(asset, TO_ADDRESS);

    expect(assetEvents.length).toBe(1);
    expect(managerEvents.length).toBe(1);
    for (const e of [assetEvents[0], managerEvents[0]]) {
      expect(e.to).toBe(TO_ADDRESS);
      expect(e.transactionId).toBe(tx.txid);
      // Ownership is the sat now; the rotation-first flag is gone (#366 ownership-is-sat).
      expect('keyRotationPending' in e).toBe(false);
    }
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

    await spySdk.lifecycle.transferOwnership(asset, TO_ADDRESS);
    // Satoshi parsed network-aware: '123456', never the 'reg' network tag.
    expect(lookedUpSatoshi).toBe('123456');
    // The inscription id is the REAL one the provider reports for that satoshi,
    // not a fabricated `insc-123456` placeholder.
    expect(capturedInscriptionId).toBe('insc-mock');
  });

  test('throws INSCRIPTION_NOT_FOUND when no inscription backs the satoshi (#273)', async () => {
    // A did:btco asset with no migration record whose satoshi carries no
    // inscription must fail loudly rather than fabricate an `insc-<sat>` id.
    const emptyProvider = new MockOrdinalsProvider();
    emptyProvider.getInscriptionsBySatoshi = async () => [];
    const s = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: emptyProvider } as any);
    const asset = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'h' }],
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:reg:999999' } as any,
      []
    );
    await expect(
      s.lifecycle.transferOwnership(asset, TO_ADDRESS)
    ).rejects.toThrow('no inscription found on satoshi');
  });
});

describe('transferOwnership is a pure sat move — writes NOTHING to the CEL (#366 ownership-is-sat)', () => {
  const makeSdk = (keyStore?: MockKeyStore, provider: OrdMockProvider = new OrdMockProvider()) =>
    OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      ...(keyStore ? { keyStore } : {})
    } as any);

  // did:cel asset carried all the way to did:btco so a transfer could (before
  // this change) have appended. It must not anymore.
  const inscribedCelAsset = async (sdk: OriginalsSDK) => {
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    return asset;
  };

  test('the sat move grows no CEL event: log length + last-event type UNCHANGED, txid returned', async () => {
    const sdk = makeSdk(new MockKeyStore());
    const asset = await inscribedCelAsset(sdk);

    const lengthBefore = asset.celLog!.events.length;
    const lastTypeBefore = asset.celLog!.events[lengthBefore - 1].type;

    const tx = await sdk.lifecycle.transferOwnership(asset, TO_ADDRESS);

    expect(typeof tx.txid).toBe('string');
    expect(tx.txid.length).toBeGreaterThan(0);
    // Ownership moved on-chain, but authorship (the CEL) did not grow.
    expect(asset.celLog!.events.length).toBe(lengthBefore);
    expect(asset.celLog!.events[asset.celLog!.events.length - 1].type).toBe(lastTypeBefore);
    expect(lastTypeBefore).not.toBe('transfer');
  });

  test('keyStore-less asset transfers identically: no degrade path, no cel:append-skipped, log untouched', async () => {
    const sdk = makeSdk(); // no keyStore
    const skipped: string[] = [];
    sdk.lifecycle.on('cel:append-skipped', (e: any) => { skipped.push(e.reason); });
    const asset = await inscribedCelAsset(sdk);
    skipped.length = 0; // ignore any inscribe-time skip

    const lengthBefore = asset.celLog!.events.length;
    const tx = await sdk.lifecycle.transferOwnership(asset, TO_ADDRESS);

    expect(typeof tx.txid).toBe('string');
    expect(tx.txid.length).toBeGreaterThan(0);
    // A pure sat move never touches the CEL, so there is nothing to skip.
    expect(skipped).toEqual([]);
    expect(asset.celLog!.events.length).toBe(lengthBefore);
    expect(asset.celLog!.events[asset.celLog!.events.length - 1].type).not.toBe('transfer');
  });
});
