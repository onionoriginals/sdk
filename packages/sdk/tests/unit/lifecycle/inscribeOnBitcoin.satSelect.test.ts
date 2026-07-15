/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';
import { sampleUtxo, sampleChangeAddress } from '../../fixtures/bitcoin';

// Extends the standard OrdMock double with the sat-index + broadcast surface
// inscribeOnSat needs: getFirstSatOfOutput derives the DID sat from the
// funding UTXO, and getInscriptionById echoes it back so the fail-closed
// SAT_MISMATCH check in inscribeOnSat passes.
class SatSelectProvider extends MockOrdinalsProvider {
  async getFirstSatOfOutput(_outpoint: { txid: string; vout: number }): Promise<string> {
    return '1777';
  }
  async getInscriptionById(id: string) {
    return {
      inscriptionId: id,
      content: Buffer.from(''),
      contentType: 'text/plain',
      txid: 'tx-reveal-mock',
      vout: 0,
      satoshi: '1777'
    };
  }
  async broadcastTransaction(_txHexOrObj: unknown): Promise<string> {
    return 'bb'.repeat(32);
  }
}

const satSigner = {
  signCommitPsbt: async (psbtBase64: string) => psbtBase64,
  getFundingAddress: () => sampleChangeAddress
};

describe('inscribeOnBitcoin (sat-selected)', () => {
  const createSDK = () => {
    const provider = new SatSelectProvider();
    return OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
  };

  const createAsset = () => new OriginalsAsset(
    [{ id: 'res1', type: 'image', contentType: 'image/png', hash: 'abc123' }],
    { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:example.com:asset1' } as any,
    []
  );

  test('inscribes the genesis did:btco onto the caller-derived sat', async () => {
    const sdk = createSDK();
    const asset = createAsset();
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, {
      fundingUtxo: sampleUtxo,
      satSigner,
      changeAddress: sampleChangeAddress,
      feeRate: 2
    });

    expect(result.currentLayer).toBe('did:btco');
    expect(asset.bindings!['did:btco']).toBe('did:btco:reg:1777');

    const prov = asset.getProvenance();
    const migration = prov.migrations[prov.migrations.length - 1];
    expect(migration.satoshi).toBe('1777');
  });

  test('rejects fundingUtxo without satSigner/changeAddress (INVALID_INPUT)', async () => {
    const sdk = createSDK();
    const asset = createAsset();
    await expect(
      sdk.lifecycle.inscribeOnBitcoin(asset, { fundingUtxo: sampleUtxo })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('legacy inscribeOnBitcoin(asset) still works with OrdMock (provider picks the sat)', async () => {
    const sdk = createSDK();
    const asset = createAsset();
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(result.currentLayer).toBe('did:btco');
    expect(asset.bindings!['did:btco']).toMatch(/^did:btco:/);
  });
});
