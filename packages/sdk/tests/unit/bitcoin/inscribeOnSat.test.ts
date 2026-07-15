import { describe, it, expect, mock } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { inscribeOnSat } from '../../../src/bitcoin/inscribe-on-sat';
import { sampleUtxo, sampleChangeAddress } from '../../fixtures/bitcoin';

// A realistic signer: parses the commit PSBT and returns broadcast-ready tx hex
// (the new BitcoinSigner contract). We can't truly sign the mock funding UTXO,
// but the funding input is segwit so the txid is witness-independent — an
// unsigned raw serialization yields the same txid the SDK computes locally.
const signer = {
  signCommitPsbt: async (psbtBase64: string) => {
    const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
    return Buffer.from(tx.toBytes(true, false)).toString('hex');
  }
};

function parse(hex: string) {
  return btc.Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
}

function providerDouble(overrides: any = {}) {
  return {
    getFirstSatOfOutput: async () => '1250000000',
    broadcastTransaction: async () => 'cc'.repeat(32),
    ...overrides
  } as any;
}

const buildContent = async (sat: string) => ({ content: Buffer.from(`doc for ${sat}`), contentType: 'application/did+json' });

const baseParams = () => ({
  buildContent, fundingUtxo: sampleUtxo, satSigner: signer,
  changeAddress: sampleChangeAddress, feeRate: 2, network: 'regtest' as const
});

describe('inscribeOnSat', () => {
  it('derives the sat from the provider and returns it as the DID sat', async () => {
    const res = await inscribeOnSat({ ...baseParams(), provider: providerDouble() });
    expect(res.satoshi).toBe('1250000000');
    expect(res.inscriptionId).toMatch(/i0$/);
  });

  it('throws SAT_INDEX_UNSUPPORTED when the provider lacks getFirstSatOfOutput', async () => {
    const provider = providerDouble({ getFirstSatOfOutput: undefined });
    await expect(inscribeOnSat({ ...baseParams(), provider }))
      .rejects.toThrow(/SAT_INDEX_UNSUPPORTED/);
  });

  it('calls the signer with the COMMIT psbt exactly once', async () => {
    const signCommitPsbt = mock(signer.signCommitPsbt);
    await inscribeOnSat({ ...baseParams(), satSigner: { signCommitPsbt }, provider: providerDouble() });
    expect(signCommitPsbt).toHaveBeenCalledTimes(1);
  });

  it('broadcasts the reveal AFTER the commit, built from the LOCAL commit txid (not a provider-returned one)', async () => {
    const broadcasts: string[] = [];
    // broadcastTransaction returns a BOGUS txid — it must not influence the reveal prevout.
    const provider = providerDouble({
      broadcastTransaction: async (hex: string) => { broadcasts.push(hex); return 'ff'.repeat(32); }
    });
    const res = await inscribeOnSat({ ...baseParams(), provider });

    // Two broadcasts, commit first then reveal.
    expect(broadcasts.length).toBe(2);

    // commitTxId is computed locally from the signed commit, NOT the bogus broadcast return.
    const localCommitTxId = parse(broadcasts[0]).id;
    expect(res.commitTxId).toBe(localCommitTxId);
    expect(res.commitTxId).not.toBe('ff'.repeat(32));

    // The reveal (broadcast second) spends the LOCAL commit txid as its prevout.
    const revealInputTxid = Buffer.from(parse(broadcasts[1]).getInput(0)!.txid!);
    const forward = revealInputTxid.toString('hex');
    const reversed = Buffer.from(revealInputTxid).reverse().toString('hex');
    expect([forward, reversed]).toContain(localCommitTxId);
    expect([forward, reversed]).not.toContain('ff'.repeat(32));
  });

  it('throws COMMIT_TX_INVALID when the signer does not return broadcast-ready hex', async () => {
    // Legacy signer that echoes the base64 PSBT — not valid tx hex.
    const badSigner = { signCommitPsbt: async (p: string) => p };
    await expect(inscribeOnSat({ ...baseParams(), satSigner: badSigner, provider: providerDouble() }))
      .rejects.toMatchObject({ code: 'COMMIT_TX_INVALID' });
  });

  it('attaches recovery data (revealTxHex + commitTxId) when the reveal broadcast fails', async () => {
    let n = 0;
    const provider = providerDouble({
      broadcastTransaction: async () => { n++; if (n === 2) throw new Error('mempool rejected reveal'); return 'ab'.repeat(32); }
    });
    try {
      await inscribeOnSat({ ...baseParams(), provider });
      throw new Error('expected REVEAL_BROADCAST_FAILED');
    } catch (e: any) {
      expect(e.code).toBe('REVEAL_BROADCAST_FAILED');
      expect(typeof e.details?.revealTxHex).toBe('string');
      expect(e.details.revealTxHex.length).toBeGreaterThan(0);
      expect(typeof e.details?.commitTxId).toBe('string');
      expect(e.details?.revealTxId).toBeDefined();
      expect(e.details?.satoshi).toBe('1250000000');
    }
  });
});
