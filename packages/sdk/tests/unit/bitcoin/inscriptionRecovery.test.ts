import { describe, it, expect, mock } from 'bun:test';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { inscribeOnSat, prepareInscriptionOnSat, resumeInscriptionOnSat, submitPreparedInscriptionOnSat } from '../../../src/bitcoin/inscribe-on-sat';
import type { InscriptionRecoveryStore } from '../../../src/bitcoin/inscription-recovery';
import { getScureNetwork } from '../../../src/bitcoin/transactions/commit';

const key = new Uint8Array(32).fill(1);
const payment = btc.p2wpkh(secp256k1.getPublicKey(key), getScureNetwork('regtest'));
const parse = (hex: string) => btc.Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
function parameters() {
  return {
    buildContent: mock(async (sat: string) => ({ content: Buffer.from(`did:btco:${sat}`), contentType: 'text/plain' })),
    fundingUtxos: [{ txid: '12'.repeat(32), vout: 0, value: 100_000, scriptPubKey: Buffer.from(payment.script).toString('hex') }],
    satSigner: { signAndFinalizeCommitPsbt: mock(async (psbt: string) => {
      const tx = btc.Transaction.fromPSBT(Buffer.from(psbt, 'base64'), { allowUnknownOutputs: true });
      tx.sign(key);
      tx.finalize();
      return tx.hex;
    }) },
    changeAddress: payment.address!, feeRate: 2, network: 'regtest' as const,
    provider: {
      getFirstSatOfOutput: mock(async () => '1250000000'),
      broadcastTransaction: mock(async (hex: string) => parse(hex).id),
      getTransactionStatus: mock(async () => ({ confirmed: false }))
    } as any
  };
}

// Reopening this store has no shared object references, signer, content, or ephemeral reveal key.
function diskStore(directory: string): InscriptionRecoveryStore {
  return {
    save: async (record) => {
      const path = join(directory, record.recoveryId);
      await writeFile(`${path}.tmp`, JSON.stringify(record), { flush: true });
      await rename(`${path}.tmp`, path);
    },
    load: async (id) => {
      try { return JSON.parse(await readFile(join(directory, id), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }
  };
}

async function withStore(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-inscription-recovery-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('signed inscription recovery', () => {
  it('survives accepted-commit response loss and restart, reusing exact bytes with no signer or sat lookup', async () => withStore(async (directory) => {
    const params = parameters();
    const accepted: string[] = [];
    params.provider.broadcastTransaction = async (hex: string) => {
      accepted.push(hex);
      const records = await diskStore(directory).load(parse(hex).id);
      expect(records!.prepared.signedCommitHex).toBe(hex);
      expect(parse(hex).getInput(0).finalScriptWitness!.length).toBeGreaterThan(0);
      throw new Error('accepted commit; lost response');
    };
    const first = await inscribeOnSat({ ...params, recoveryStore: diskStore(directory) });
    expect(first.broadcast).toBe('commit_broadcast_unknown');
    const retryProvider = {
      broadcastTransaction: async (hex: string) => { accepted.push(hex); return parse(hex).id; }
    } as any;
    const resumed = await resumeInscriptionOnSat({ recoveryId: first.recoveryId, provider: retryProvider, recoveryStore: diskStore(directory) });
    expect(resumed.broadcast).toBe('reveal_broadcast');
    expect(accepted).toEqual([first.prepared.signedCommitHex, first.prepared.signedCommitHex, first.prepared.revealTxHex]);
    expect(params.satSigner.signAndFinalizeCommitPsbt).toHaveBeenCalledTimes(1);
    expect(params.buildContent).toHaveBeenCalledTimes(1);
    expect(params.provider.getFirstSatOfOutput).toHaveBeenCalledTimes(1);
    // A completed retry reads the durable acknowledgement and submits nothing.
    await resumeInscriptionOnSat({ recoveryId: first.recoveryId, provider: retryProvider, recoveryStore: diskStore(directory) });
    expect(accepted).toHaveLength(3);
  }));

  it('retries only the same reveal after second-broadcast response loss', async () => withStore(async (directory) => {
    const params = parameters();
    const attempts: string[] = [];
    params.provider.broadcastTransaction = async (hex: string) => {
      attempts.push(hex);
      if (attempts.length === 2) throw new Error('lost reveal response');
      return parse(hex).id;
    };
    const first = await inscribeOnSat({ ...params, recoveryStore: diskStore(directory) });
    expect(first.broadcast).toBe('reveal_broadcast_unknown');
    const resumed = await resumeInscriptionOnSat({ recoveryId: first.recoveryId, provider: params.provider, recoveryStore: diskStore(directory) });
    expect(resumed.broadcast).toBe('reveal_broadcast');
    expect(attempts).toEqual([first.prepared.signedCommitHex, first.prepared.revealTxHex, first.prepared.revealTxHex]);
  }));

  it('resumes a prepared record after restart before any network side effect', async () => withStore(async (directory) => {
    const params = parameters();
    const prepared = await prepareInscriptionOnSat(params);
    await diskStore(directory).save({ recoveryId: prepared.commitTxId, prepared, broadcast: 'prepared' });
    expect(params.provider.broadcastTransaction).not.toHaveBeenCalled();
    const resumed = await resumeInscriptionOnSat({ recoveryId: prepared.commitTxId, provider: params.provider, recoveryStore: diskStore(directory) });
    expect(resumed.prepared).toEqual(prepared);
    expect(resumed.broadcast).toBe('reveal_broadcast');
    expect(params.satSigner.signAndFinalizeCommitPsbt).toHaveBeenCalledTimes(1);
  }));

  it('broadcasts nothing when durable persistence fails or no store is supplied', async () => {
    const params = parameters();
    await expect(inscribeOnSat(params)).rejects.toMatchObject({ code: 'INSCRIPTION_RECOVERY_REQUIRED' });
    await expect(inscribeOnSat({ ...params, recoveryStore: {
      load: async () => undefined, save: async () => { throw new Error('disk full'); }
    } })).rejects.toMatchObject({ code: 'INSCRIPTION_RECOVERY_PERSIST_FAILED' });
    expect(params.provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('preserves durable provider submission without a local store and detects mismatched ids', async () => {
    const params = parameters();
    params.provider.submitInscription = mock(async (p: any) => ({ commitTxId: parse(p.signedCommitHex).id, revealTxId: parse(p.revealTxHex).id, status: 'commit_broadcast' }));
    const first = await inscribeOnSat(params);
    expect(first.broadcast).toBe('commit_broadcast');
    expect(params.provider.broadcastTransaction).not.toHaveBeenCalled();
    params.provider.submitInscription = async () => ({ commitTxId: 'ff'.repeat(32), revealTxId: first.revealTxId, status: 'reveal_broadcast' });
    const second = await submitPreparedInscriptionOnSat({ prepared: first.prepared, provider: params.provider });
    expect(second.broadcast).toBe('commit_broadcast_unknown');
    expect(second.error).toContain('do not match');
  });

  it('rejects corrupted transaction identities and funding order before broadcasting', async () => {
    const params = parameters();
    const prepared = await prepareInscriptionOnSat(params);
    for (const changed of [
      { ...prepared, revealTxId: 'ff'.repeat(32) },
      { ...prepared, fundingUtxos: [{ ...prepared.fundingUtxos[0], vout: 1 }] },
      { ...prepared, network: 'mainnet' as const },
      { ...prepared, signedCommitHex: prepared.signedCommitHex + 'xx' }
    ]) {
      await expect(submitPreparedInscriptionOnSat({ prepared: changed, provider: params.provider })).rejects.toMatchObject({ code: 'INVALID_INSCRIPTION_RECOVERY' });
    }
    expect(params.provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('resolves an already confirmed commit after its duplicate broadcast returns an error', async () => withStore(async (directory) => {
    const params = parameters();
    let calls = 0;
    params.provider.broadcastTransaction = async (hex: string) => {
      if (++calls === 1) throw new Error('already in chain');
      return parse(hex).id;
    };
    params.provider.getTransactionStatus = async () => ({ confirmed: true });
    const result = await inscribeOnSat({ ...params, recoveryStore: diskStore(directory) });
    expect(result.broadcast).toBe('reveal_broadcast');
    expect(calls).toBe(2);
  }));
});
