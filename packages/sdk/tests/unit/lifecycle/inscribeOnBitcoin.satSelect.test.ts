/* istanbul ignore file */
import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { OriginalsSDK, OriginalsAsset } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { sampleUtxo, sampleChangeAddress } from '../../fixtures/bitcoin';

// Extends the standard OrdMock double with the sat-index surface inscribeOnSat
// needs: getFirstSatOfOutput derives the DID sat from the funding UTXO. The
// model is fire-and-forget — there is NO post-broadcast sat re-check, so no
// getInscriptionById echo is required.
class SatSelectProvider extends MockOrdinalsProvider {
  async getFirstSatOfOutput(_outpoint: { txid: string; vout: number }): Promise<string> {
    return '1777';
  }
  async broadcastTransaction(_txHexOrObj: unknown): Promise<string> {
    return 'bb'.repeat(32);
  }
}

// Fee estimation always fails on this provider — used to exercise the
// FEE_RATE_REQUIRED fail-closed path when no explicit feeRate is supplied.
class NoFeeSatSelectProvider extends SatSelectProvider {
  async estimateFee(_blocks?: number): Promise<number> {
    throw new Error('no fee estimate available');
  }
}

// Realistic signer honoring the new contract: returns broadcast-ready tx hex
// (not the base64 PSBT). The funding input is segwit so the txid is
// witness-independent — an unsigned raw serialization yields the same txid the
// SDK computes locally.
const satSigner = {
  signAndFinalizeCommitPsbt: async (psbtBase64: string) => {
    const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
    return Buffer.from(tx.toBytes(true, false)).toString('hex');
  }
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

  test('throws FEE_RATE_REQUIRED when no feeRate and no fee estimate are available', async () => {
    const provider = new NoFeeSatSelectProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const asset = createAsset();
    await expect(
      sdk.lifecycle.inscribeOnBitcoin(asset, { fundingUtxo: sampleUtxo, satSigner, changeAddress: sampleChangeAddress })
    ).rejects.toMatchObject({ code: 'FEE_RATE_REQUIRED' });
  });

  test('preserves the migrate CEL event (no rollback) and reaches a coherent btco state when the reveal broadcast fails', async () => {
    // The reveal broadcast (2nd broadcastTransaction call) fails, but the commit
    // is already on-chain and the reveal is recoverable via revealTxHex. The
    // migrate event MUST NOT be rolled back — doing so would desync the log from
    // an inscription that can still land. A keyStore is required so the CEL
    // migrate event actually appends (otherwise it degrades to append-skipped).
    let n = 0;
    class FailRevealProvider extends SatSelectProvider {
      async broadcastTransaction(_tx: unknown): Promise<string> {
        n++;
        if (n === 2) throw new Error('mempool rejected reveal');
        return 'bb'.repeat(32);
      }
    }
    const provider = new FailRevealProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    } as any);
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    const eventsBefore = asset.celLog!.events.length;

    await expect(
      sdk.lifecycle.inscribeOnBitcoin(asset, {
        fundingUtxo: sampleUtxo,
        satSigner,
        changeAddress: sampleChangeAddress,
        feeRate: 2
      })
    ).rejects.toMatchObject({ code: 'REVEAL_BROADCAST_FAILED' });

    // The migrate event survived the failure (NOT rolled back).
    const migrate = asset.celLog!.events.find(e => e.type === 'migrate');
    expect(migrate).toBeDefined();
    expect(asset.celLog!.events.length).toBeGreaterThan(eventsBefore);

    // Coherent "migrated, inscription pending" state: layer advanced + binding set,
    // matching a successful-but-unconfirmed inscription.
    expect(asset.currentLayer).toBe('did:btco');
    expect(asset.bindings!['did:btco']).toBe('did:btco:reg:1777');

    // verify / replay fold from the log without blowing up (return, not throw).
    const ok = await asset.verify({ ordinalsProvider: provider as any });
    expect(typeof ok).toBe('boolean');
    expect(() => asset.getProvenance()).not.toThrow();
  });

  test('legacy inscribeOnBitcoin(asset) still works with OrdMock (provider picks the sat)', async () => {
    const sdk = createSDK();
    const asset = createAsset();
    const result = await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(result.currentLayer).toBe('did:btco');
    expect(asset.bindings!['did:btco']).toMatch(/^did:btco:/);
  });
});
