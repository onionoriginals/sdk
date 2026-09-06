import { describe, it, expect, mock } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { inscribeOnSat, prepareInscriptionOnSat, submitPreparedInscriptionOnSat, resumeInscriptionOnSat } from '../../../src/bitcoin/inscribe-on-sat';
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
    broadcastTransaction: async (hex: string) => parse(hex).id,
    ...overrides
  } as any;
}

const buildContent = async (sat: string) => ({ content: Buffer.from(`doc for ${sat}`), contentType: 'application/did+json' });

const recoveryStore = () => {
  const records = new Map<string, any>();
  return {
    save: async (record: any) => { records.set(record.recoveryId, JSON.parse(JSON.stringify(record))); },
    load: async (id: string) => records.get(id)
  };
};

const baseParams = () => ({
  recoveryStore: recoveryStore(),
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

  it('broadcasts the reveal AFTER the commit, built from the LOCAL commit txid', async () => {
    const broadcasts: string[] = [];
    const provider = providerDouble({
      broadcastTransaction: async (hex: string) => { broadcasts.push(hex); return parse(hex).id; }
    });
    const res = await inscribeOnSat({ ...baseParams(), provider });

    // Two broadcasts, commit first then reveal.
    expect(broadcasts.length).toBe(2);

    // commitTxId is independently computed locally from the exact signed commit.
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

  it('returns submission ambiguity with full exact recovery bytes when submitInscription fails', async () => {
    const provider = providerDouble({ submitInscription: async () => { throw new Error('network died mid-POST'); } });
    const res = await inscribeOnSat({ ...baseParams(), provider });
    expect(res.broadcast).toBe('commit_broadcast_unknown');
    expect(parse(res.prepared.signedCommitHex).id).toBe(res.commitTxId);
    expect(parse(res.prepared.revealTxHex).id).toBe(res.revealTxId);
    expect(res.error).toBe('network died mid-POST');
  });

  it('returns reveal ambiguity and exact pair when the second broadcast fails', async () => {
    let n = 0;
    const provider = providerDouble({ broadcastTransaction: async (hex: string) => {
      if (++n === 2) throw new Error('response lost');
      return parse(hex).id;
    } });
    const res = await inscribeOnSat({ ...baseParams(), provider });
    expect(res.broadcast).toBe('reveal_broadcast_unknown');
    expect(parse(res.prepared.revealTxHex).id).toBe(res.revealTxId);
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
      broadcastTransaction: async (hex: string) => { broadcasts.push(hex); return parse(hex).id; }
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

/**
 * `broadcast` — how far broadcasting actually got.
 *
 * From the first real mainnet inscription: the provider reported
 * `status: 'commit_broadcast'` (commit on-chain, reveal persisted for
 * rebroadcast), the SDK discarded submitInscription's return value, and the
 * caller had no way to tell that from a completed pair. A UI built on that
 * announced an inscription and linked to a reveal txid that 404'd.
 */
describe('inscribeOnSat reports how far broadcasting got', () => {
  it('reports reveal_broadcast when both transactions reached the network', async () => {
    const provider = providerDouble({
      submitInscription: async (p: any) => ({ commitTxId: parse(p.signedCommitHex).id, revealTxId: parse(p.revealTxHex).id, status: 'reveal_broadcast' })
    });
    const res = await inscribeOnSat({ ...baseParams(), satSigner: signer, provider });
    expect(res.broadcast).toBe('reveal_broadcast');
  });

  it('reports commit_broadcast when only the commit did — the case that used to be invisible', async () => {
    const provider = providerDouble({
      submitInscription: async (p: any) => ({ commitTxId: parse(p.signedCommitHex).id, revealTxId: parse(p.revealTxHex).id, status: 'commit_broadcast' })
    });
    const res = await inscribeOnSat({ ...baseParams(), satSigner: signer, provider });
    expect(res.broadcast).toBe('commit_broadcast');
    // Still a success: the reveal completes without the caller re-signing.
    expect(res.revealTxId).toBeTruthy();
    expect(res.inscriptionId).toBeTruthy();
  });

  it.each([undefined, null, 'garbage'])('keeps missing or invalid provider status %s unknown', async (status) => {
    const provider = providerDouble({
      submitInscription: async (p: any) => ({ commitTxId: parse(p.signedCommitHex).id, revealTxId: parse(p.revealTxHex).id, status })
    });
    const res = await inscribeOnSat({ ...baseParams(), provider });
    expect(res.broadcast).toBe('commit_broadcast_unknown');
    expect(res.error).toContain('status');
  });

  it('reports reveal_broadcast on the two-broadcast fallback path', async () => {
    // No submitInscription seam: both broadcasts must have succeeded to get
    // a failed reveal now returns an explicit unknown state.
    const provider = providerDouble();
    delete (provider as any).submitInscription;
    const res = await inscribeOnSat({ ...baseParams(), satSigner: signer, provider });
    expect(res.broadcast).toBe('reveal_broadcast');
  });
});


describe('durable signed-pair recovery (#566)', () => {
  it('returns unknown commit state with the exact durable pair after accepted commit loses its response', async () => {
    let persisted: any;
    const broadcasts: string[] = [];
    const recoveryStore = {
      save: async (record: any) => { persisted = JSON.parse(JSON.stringify(record)); },
      load: async () => persisted
    };
    const result = await inscribeOnSat({
      ...baseParams(), recoveryStore,
      provider: providerDouble({ broadcastTransaction: async (hex: string) => {
        broadcasts.push(hex);
        throw new Error('accepted, then response lost');
      } })
    } as any);
    expect(result.broadcast).toBe('commit_broadcast_unknown');
    expect(persisted.prepared.signedCommitHex).toBe(broadcasts[0]);
    expect(Buffer.from(parse(persisted.prepared.revealTxHex).getInput(0).txid!).toString('hex')).toBe(parse(broadcasts[0]).id);
  });
});


describe('signed commit template integrity', () => {
  it.each(['script', 'amount', 'missing', 'sequence', 'lockTime', 'version'])('rejects signer changes to %s before broadcast', async (change) => {
    const provider = providerDouble({ broadcastTransaction: mock(async (hex: string) => parse(hex).id) });
    const satSigner = { signAndFinalizeCommitPsbt: async (psbt: string) => {
      const original = btc.Transaction.fromPSBT(Buffer.from(psbt, 'base64'), { allowUnknownOutputs: true });
      expect(original.outputsLength).toBe(2);
      const rebuilt = new btc.Transaction({
        allowUnknownOutputs: true, allowUnknownInputs: true,
        version: change === 'version' ? original.version + 1 : original.version,
        lockTime: change === 'lockTime' ? original.lockTime + 1 : original.lockTime
      });
      for (let i = 0; i < original.inputsLength; i++) {
        const input = original.getInput(i);
        rebuilt.addInput(change === 'sequence' ? { ...input, sequence: 0xfffffffe } : input);
      }
      rebuilt.addOutput(original.getOutput(0));
      if (change !== 'missing') {
        const output = original.getOutput(1);
        rebuilt.addOutput({ ...output,
          ...(change === 'script' ? { script: new Uint8Array([0, 20, ...new Uint8Array(20).fill(7)]) } : {}),
          ...(change === 'amount' ? { amount: output.amount! - 1n } : {})
        });
      }
      return Buffer.from(rebuilt.toBytes(true, false)).toString('hex');
    } };
    await expect(inscribeOnSat({ ...baseParams(), provider, satSigner })).rejects.toMatchObject({ code: 'COMMIT_TX_MISMATCH' });
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });
});
