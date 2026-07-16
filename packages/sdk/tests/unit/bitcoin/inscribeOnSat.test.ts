import { describe, it, expect, mock } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { inscribeOnSat } from '../../../src/bitcoin/inscribe-on-sat';
import { getScureNetwork } from '../../../src/bitcoin/transactions/commit';
import { sampleUtxo, sampleChangeAddress } from '../../fixtures/bitcoin';

// A realistic signer: parses the commit PSBT and returns broadcast-ready tx hex
// (the new BitcoinSigner contract). We can't truly sign the mock funding UTXO,
// but the funding input is segwit so the txid is witness-independent — an
// unsigned raw serialization yields the same txid the SDK computes locally.
const signer = {
  signAndFinalizeCommitPsbt: async (psbtBase64: string) => {
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
    const signAndFinalizeCommitPsbt = mock(signer.signAndFinalizeCommitPsbt);
    await inscribeOnSat({ ...baseParams(), satSigner: { signAndFinalizeCommitPsbt }, provider: providerDouble() });
    expect(signAndFinalizeCommitPsbt).toHaveBeenCalledTimes(1);
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
    const badSigner = { signAndFinalizeCommitPsbt: async (p: string) => p };
    await expect(inscribeOnSat({ ...baseParams(), satSigner: badSigner, provider: providerDouble() }))
      .rejects.toMatchObject({ code: 'COMMIT_TX_INVALID' });
  });

  it('throws COMMIT_TX_MISMATCH (and broadcasts nothing) when the signed tx spends a different input than fundingUtxo', async () => {
    // A validly-parseable tx, but its input[0] is NOT fundingUtxo — e.g. a signer
    // bug that funded from the wrong UTXO. Must be rejected before any broadcast.
    const wrongInputSigner = {
      signAndFinalizeCommitPsbt: async () => {
        const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
        tx.addInput({
          txid: 'ff'.repeat(32),
          index: 0,
          sequence: 0xfffffffd,
          witnessUtxo: { amount: BigInt(sampleUtxo.value), script: Buffer.from(sampleUtxo.scriptPubKey, 'hex') }
        });
        tx.addOutputAddress(sampleChangeAddress, 852n, getScureNetwork('regtest'));
        return Buffer.from(tx.toBytes(true, false)).toString('hex');
      }
    };
    const broadcastTransaction = mock(async () => 'cc'.repeat(32));
    const provider = providerDouble({ broadcastTransaction });
    await expect(inscribeOnSat({ ...baseParams(), satSigner: wrongInputSigner, provider }))
      .rejects.toMatchObject({ code: 'COMMIT_TX_MISMATCH' });
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('throws COMMIT_TX_MISMATCH (and broadcasts nothing) when the signed tx pays the wrong output', async () => {
    // Correct input, but output[0] doesn't match the commit output the SDK built
    // (wrong destination address here, standing in for wrong amount/script).
    const wrongOutputSigner = {
      signAndFinalizeCommitPsbt: async () => {
        const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
        tx.addInput({
          txid: sampleUtxo.txid,
          index: sampleUtxo.vout,
          sequence: 0xfffffffd,
          witnessUtxo: { amount: BigInt(sampleUtxo.value), script: Buffer.from(sampleUtxo.scriptPubKey, 'hex') }
        });
        // Pays the change address instead of the commit (P2TR) output.
        tx.addOutputAddress(sampleChangeAddress, 852n, getScureNetwork('regtest'));
        return Buffer.from(tx.toBytes(true, false)).toString('hex');
      }
    };
    const broadcastTransaction = mock(async () => 'cc'.repeat(32));
    const provider = providerDouble({ broadcastTransaction });
    await expect(inscribeOnSat({ ...baseParams(), satSigner: wrongOutputSigner, provider }))
      .rejects.toMatchObject({ code: 'COMMIT_TX_MISMATCH' });
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('throws COMMIT_TX_MISMATCH (and broadcasts nothing) when the signed tx has an EXTRA input', async () => {
    // input[0]==fundingUtxo and output[0]==the commit output are BOTH intact, but
    // the signer appended a second input spending an unrelated UTXO. Bounding the
    // input count to exactly 1 is what catches this before any broadcast.
    const extraInputSigner = {
      signAndFinalizeCommitPsbt: async (psbtBase64: string) => {
        const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
        tx.addInput({
          txid: 'ee'.repeat(32),
          index: 1,
          sequence: 0xfffffffd,
          witnessUtxo: { amount: BigInt(sampleUtxo.value), script: Buffer.from(sampleUtxo.scriptPubKey, 'hex') }
        });
        return Buffer.from(tx.toBytes(true, false)).toString('hex');
      }
    };
    const broadcastTransaction = mock(async () => 'cc'.repeat(32));
    const provider = providerDouble({ broadcastTransaction });
    await expect(inscribeOnSat({ ...baseParams(), satSigner: extraInputSigner, provider }))
      .rejects.toMatchObject({ code: 'COMMIT_TX_MISMATCH' });
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('throws COMMIT_TX_MISMATCH (and broadcasts nothing) when the signed tx has EXTRA outputs', async () => {
    // input[0] and output[0] are intact, but the signer appended extra outputs
    // (e.g. redirecting change to an attacker). Bounding outputs to at most 2
    // (commit + optional change) rejects it before any broadcast.
    const extraOutputSigner = {
      signAndFinalizeCommitPsbt: async (psbtBase64: string) => {
        const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
        // Add outputs until the tx has at least 3 (exceeds the commit+change bound).
        while (tx.outputsLength < 3) {
          tx.addOutputAddress(sampleChangeAddress, 546n, getScureNetwork('regtest'));
        }
        return Buffer.from(tx.toBytes(true, false)).toString('hex');
      }
    };
    const broadcastTransaction = mock(async () => 'cc'.repeat(32));
    const provider = providerDouble({ broadcastTransaction });
    await expect(inscribeOnSat({ ...baseParams(), satSigner: extraOutputSigner, provider }))
      .rejects.toMatchObject({ code: 'COMMIT_TX_MISMATCH' });
    expect(broadcastTransaction).not.toHaveBeenCalled();
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
