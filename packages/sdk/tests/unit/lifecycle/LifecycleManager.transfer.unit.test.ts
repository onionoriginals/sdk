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

  test('extracts satoshi network-blindly from a regtest btco DID with no migration record', async () => {
    // Regression: for `did:btco:reg:<sat>` the old `split(':')[2]` returned the
    // network tag 'reg' instead of the satoshi, so the transfer looked up the
    // wrong (nonexistent) ordinal. With no migration record present, the
    // satoshi must come from parsing the DID network-aware.
    let capturedInscriptionId: string | undefined;
    const spyProvider = new MockOrdinalsProvider();
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
    // inscriptionId is derived as `insc-<satoshi>` when no migration record exists.
    expect(capturedInscriptionId).toBe('insc-123456');
    expect(capturedInscriptionId).not.toContain('reg');
  });
});

