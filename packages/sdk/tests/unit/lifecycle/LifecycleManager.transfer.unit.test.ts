/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';

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

