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
  buildContent, fundingUtxos: [sampleUtxo], satSigner: signer,
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

  it('prefers submitInscription over two broadcasts when the provider offers it (stranded-funds seam)', async () => {
    const broadcastTransaction = mock(async () => 'cc'.repeat(32));
    let submitted: any = null;
    const provider = providerDouble({
      broadcastTransaction,
      submitInscription: async (params: any) => {
        submitted = params;
        return { commitTxId: parse(params.signedCommitHex).id, revealTxId: parse(params.revealTxHex).id, status: 'reveal_broadcast' };
      }
    });
    const res = await inscribeOnSat({ ...baseParams(), provider });

    // The atomic seam carried BOTH signed txs in one call; the sequential
    // broadcast path never ran.
    expect(broadcastTransaction).not.toHaveBeenCalled();
    expect(submitted).not.toBeNull();
    expect(parse(submitted.signedCommitHex).id).toBe(res.commitTxId);
    expect(parse(submitted.revealTxHex).id).toBe(res.revealTxId);
    expect(submitted.fundingUtxos.map((u: any) => u.txid)).toEqual([sampleUtxo.txid]);
    expect(submitted.changeAddress).toBe(sampleChangeAddress);
  });

  it('throws INSCRIPTION_SUBMIT_FAILED with full recovery data when submitInscription fails', async () => {
    const provider = providerDouble({
      submitInscription: async () => { throw new Error('network died mid-POST'); }
    });
    try {
      await inscribeOnSat({ ...baseParams(), provider });
      throw new Error('expected INSCRIPTION_SUBMIT_FAILED');
    } catch (e: any) {
      expect(e.code).toBe('INSCRIPTION_SUBMIT_FAILED');
      // Recovery must not depend on this process's memory: both signed txs ride
      // in the error details.
      expect(typeof e.details?.signedCommitHex).toBe('string');
      expect(typeof e.details?.revealTxHex).toBe('string');
      expect(typeof e.details?.commitTxId).toBe('string');
      expect(e.details?.satoshi).toBe('1250000000');
    }
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

/**
 * Multi-input funding (R26): a creator who deposited twice, or topped up after
 * a fee rise, funds ONE inscription from several UTXOs. The identity rule is
 * pinned rather than inferred: the did:btco sat is the first sat of the FIRST
 * declared input (ordinal FIFO), so the whole declared set — in order — must
 * be what the signer returns.
 */
describe('inscribeOnSat — multi-input funding', () => {
  // The identity UTXO is deliberately the SMALLER one: ordinary value-descending
  // selection would reorder (or drop) it, which would silently move the DID sat.
  const identityUtxo = { ...sampleUtxo, txid: `${'1'.repeat(62)}00`, vout: 0, value: 3_000 };
  const topUpUtxo = { ...sampleUtxo, txid: `${'2'.repeat(62)}01`, vout: 1, value: 90_000 };
  const twoInputParams = () => ({ ...baseParams(), fundingUtxos: [identityUtxo, topUpUtxo] });

  it('accepts a two-input commit and spends the declared set in the declared order', async () => {
    const broadcasts: string[] = [];
    const provider = providerDouble({
      broadcastTransaction: async (hex: string) => { broadcasts.push(hex); return 'cc'.repeat(32); }
    });
    const res = await inscribeOnSat({ ...twoInputParams(), provider });
    expect(res.satoshi).toBe('1250000000');

    const commit = parse(broadcasts[0]);
    expect(commit.inputsLength).toBe(2);
    const outpoints = [0, 1].map((i) => {
      const inp = commit.getInput(i)!;
      return `${Buffer.from(inp.txid!).toString('hex')}:${inp.index}`;
    });
    expect(outpoints).toEqual([`${identityUtxo.txid}:0`, `${topUpUtxo.txid}:1`]);
  });

  it('derives the DID sat from the PINNED FIRST input, not from whichever input is largest', async () => {
    const queried: Array<{ txid: string; vout: number }> = [];
    const provider = providerDouble({
      getFirstSatOfOutput: async (o: { txid: string; vout: number }) => { queried.push(o); return '1250000000'; }
    });
    await inscribeOnSat({ ...twoInputParams(), provider });
    expect(queried).toEqual([{ txid: identityUtxo.txid, vout: 0 }]);
  });

  it('throws COMMIT_TX_MISMATCH when the signed commit drops one of the declared inputs', async () => {
    const droppingSigner = {
      signAndFinalizeCommitPsbt: async (psbtBase64: string) => {
        const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
        const rebuilt = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
        rebuilt.addInput(tx.getInput(0)!);
        for (let i = 0; i < tx.outputsLength; i++) rebuilt.addOutput(tx.getOutput(i)!);
        return Buffer.from(rebuilt.toBytes(true, false)).toString('hex');
      }
    };
    const broadcastTransaction = mock(async () => 'cc'.repeat(32));
    await expect(inscribeOnSat({ ...twoInputParams(), satSigner: droppingSigner, provider: providerDouble({ broadcastTransaction }) }))
      .rejects.toMatchObject({ code: 'COMMIT_TX_MISMATCH' });
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('throws COMMIT_TX_MISMATCH when the signed commit REORDERS the declared inputs (the DID sat would move)', async () => {
    const reorderingSigner = {
      signAndFinalizeCommitPsbt: async (psbtBase64: string) => {
        const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
        const rebuilt = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
        rebuilt.addInput(tx.getInput(1)!);
        rebuilt.addInput(tx.getInput(0)!);
        for (let i = 0; i < tx.outputsLength; i++) rebuilt.addOutput(tx.getOutput(i)!);
        return Buffer.from(rebuilt.toBytes(true, false)).toString('hex');
      }
    };
    const broadcastTransaction = mock(async () => 'cc'.repeat(32));
    await expect(inscribeOnSat({ ...twoInputParams(), satSigner: reorderingSigner, provider: providerDouble({ broadcastTransaction }) }))
      .rejects.toMatchObject({ code: 'COMMIT_TX_MISMATCH' });
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it('hands the WHOLE declared funding set to submitInscription (the server re-checks it)', async () => {
    let submitted: any = null;
    const provider = providerDouble({
      submitInscription: async (params: any) => {
        submitted = params;
        return { commitTxId: parse(params.signedCommitHex).id, revealTxId: parse(params.revealTxHex).id, status: 'reveal_broadcast' };
      }
    });
    await inscribeOnSat({ ...twoInputParams(), provider });
    expect(submitted.fundingUtxos.map((u: any) => `${u.txid}:${u.vout}`))
      .toEqual([`${identityUtxo.txid}:0`, `${topUpUtxo.txid}:1`]);
    // Legacy singular field still carries the IDENTITY input, so an older
    // server that only reads `fundingUtxo` reads the identity outpoint.
    expect(submitted.fundingUtxo.txid).toBe(identityUtxo.txid);
  });

  it('rejects an empty funding set before touching the provider', async () => {
    const getFirstSatOfOutput = mock(async () => '1250000000');
    await expect(inscribeOnSat({ ...baseParams(), fundingUtxos: [], provider: providerDouble({ getFirstSatOfOutput }) }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(getFirstSatOfOutput).not.toHaveBeenCalled();
  });

  it('rejects a funding set that names the same outpoint twice', async () => {
    await expect(inscribeOnSat({ ...baseParams(), fundingUtxos: [identityUtxo, { ...identityUtxo }], provider: providerDouble() }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
