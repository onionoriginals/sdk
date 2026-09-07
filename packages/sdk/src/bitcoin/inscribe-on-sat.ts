import * as btc from '@scure/btc-signer';
import { Utxo } from '../types/bitcoin.js';
import { BitcoinSigner } from '../types/common.js';
import { OrdinalsProvider } from '../adapters/types.js';
import { StructuredError } from '@originals/cel';
import { validateSatoshiNumber } from '@originals/cel';
import { createCommitTransaction, createRevealTransaction } from './transactions/commit.js';
import { scriptPubKeyForAddress } from './transfer.js';
import { submitPreparedInscriptionOnSat } from './inscription-recovery.js';
import type { PreparedInscriptionOnSat, InscriptionRecoveryStore, InscriptionBroadcastState } from './inscription-recovery.js';
export { submitPreparedInscriptionOnSat, resumeInscriptionOnSat } from './inscription-recovery.js';
export type { PreparedInscriptionOnSat, InscriptionRecoveryRecord, InscriptionRecoveryStore, InscriptionBroadcastState } from './inscription-recovery.js';

export interface InscribeOnSatParams {
  buildContent: (satoshi: string) => Promise<{ content: Uint8Array; contentType: string; metadata?: Record<string, unknown> }>;
  /**
   * The funding UTXOs this inscription spends, in the order they are spent.
   * `fundingUtxos[0]` is the IDENTITY input: its first sat becomes the
   * did:btco sat (ordinals FIFO), so its position is pinned and asserted, not
   * inferred from how many inputs there happen to be.
   */
  fundingUtxos: Utxo[];
  satSigner: BitcoinSigner;
  changeAddress: string;
  feeRate: number;
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  provider: OrdinalsProvider;
  /** Required for direct broadcast providers. save() must complete durable storage before resolving. */
  recoveryStore?: InscriptionRecoveryStore;
}

export interface InscribeOnSatResult {
  satoshi: string;          // the derived DID sat (from the provider's sat index)
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
  /** A broadcast acknowledgement is not chain confirmation; unknown states require same-pair recovery. */
  broadcast: InscriptionBroadcastState;
  recoveryId: string;
  /** Exact recovery bytes, also persisted before direct broadcasting. */
  prepared: PreparedInscriptionOnSat;
  error?: string;
}

/** Prepare and durably submit a sat-selected pair. Retry using resumeInscriptionOnSat, never by re-signing. */
export async function inscribeOnSat(params: InscribeOnSatParams): Promise<InscribeOnSatResult> {
  const prepared = await prepareInscriptionOnSat(params);
  return submitPreparedInscriptionOnSat({ prepared, provider: params.provider, recoveryStore: params.recoveryStore });
}

/** Build both transactions and compute their identities without broadcasting or requiring a recovery store. */
export async function prepareInscriptionOnSat(params: InscribeOnSatParams): Promise<PreparedInscriptionOnSat> {
  const { buildContent, fundingUtxos, satSigner, changeAddress, feeRate, network, provider } = params;

  // 0) The funding set must be a real, non-degenerate list before anything —
  // including a provider lookup — happens. A duplicate outpoint would build a
  // tx that can never be relayed (the same input twice).
  if (!Array.isArray(fundingUtxos) || fundingUtxos.length === 0) {
    throw new StructuredError('INVALID_INPUT', 'inscribeOnSat requires at least one funding UTXO.');
  }
  const outpoints = fundingUtxos.map((u) => `${u.txid.toLowerCase()}:${u.vout}`);
  if (new Set(outpoints).size !== outpoints.length) {
    throw new StructuredError('INVALID_INPUT', 'The funding set names the same outpoint more than once.');
  }
  // The FIRST input carries the identity sat — pinned here, asserted below.
  const identityUtxo = fundingUtxos[0];

  if (typeof provider.getFirstSatOfOutput !== 'function') {
    throw new StructuredError('SAT_INDEX_UNSUPPORTED',
      'SAT_INDEX_UNSUPPORTED: the ordinals provider cannot resolve the funding output\'s sat (no sat index); cannot select the did:btco sat.');
  }

  // 1) Derive the authoritative DID sat from the provider.
  const satoshi = await provider.getFirstSatOfOutput({ txid: identityUtxo.txid, vout: identityUtxo.vout });
  const v = validateSatoshiNumber(satoshi);
  if (!v.valid) throw new StructuredError('INVALID_SATOSHI', `Provider returned invalid sat: ${v.error}`);

  // 2) Build content embedding did:btco:<sat> (caller's closure appends the CEL migrate event).
  const { content, contentType, metadata } = await buildContent(satoshi);

  // 3) Unsigned commit: the declared funding inputs (identity first),
  // inscription output at vout 0, no pointer. exactUtxos keeps the caller's
  // set AND order — ordinary selection would sort value-descending and could
  // drop the identity input, silently moving the DID sat.
  const commit = await createCommitTransaction({
    content, contentType, metadata, exactUtxos: true,
    utxos: fundingUtxos, changeAddress, feeRate, network
  });
  const selected = commit.selectedUtxos.map((u) => `${u.txid.toLowerCase()}:${u.vout}`);
  if (selected.length !== outpoints.length || selected.some((o, i) => o !== outpoints[i])) {
    throw new StructuredError('COMMIT_TX_MISMATCH',
      'The built commit does not spend the declared funding set in order; refusing to continue (the DID sat would be wrong).',
      { declared: outpoints, selected });
  }

  const template = btc.Transaction.fromPSBT(Buffer.from(commit.commitPsbtBase64, 'base64'), {
    allowUnknownOutputs: true
  });

  // 4) Caller signs the commit; the return MUST be broadcast-ready tx hex.
  const signedCommit = await satSigner.signAndFinalizeCommitPsbt(commit.commitPsbtBase64);

  // 5) Compute the commit txid LOCALLY from the signed tx. The funding input is
  // segwit, so the txid is witness-independent — never trust a provider-returned
  // txid to build the reveal's prevout.
  let commitTxId: string;
  let parsed: btc.Transaction;
  try {
    parsed = btc.Transaction.fromRaw(Buffer.from(signedCommit, 'hex'), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true
    });
    commitTxId = parsed.id;
  } catch (e) {
    throw new StructuredError('COMMIT_TX_INVALID',
      `Signer returned a commit transaction that could not be parsed as broadcast-ready hex: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 5b) Invariant: the signed tx must actually BE the commit we built for this
  // funding UTXO, not merely something parseable. A buggy/malicious signer could
  // return a different, validly-formed tx (wrong input, wrong output) which would
  // silently land the DID on the wrong sat. Check the inputs against the
  // declared funding set (in order), every output amount/script, sequence,
  // version and locktime against the original PSBT BEFORE broadcasting.
  // This also protects the change output from redirection, omission or fee inflation.
  const mismatchDetails = { fundingUtxos: outpoints, commitAmount: commit.commitAmount, commitAddress: commit.commitAddress };
  if (parsed.inputsLength !== fundingUtxos.length || parsed.outputsLength !== template.outputsLength ||
      parsed.version !== template.version || parsed.lockTime !== template.lockTime) {
    throw new StructuredError('COMMIT_TX_MISMATCH',
      'The signed commit does not match the commit built for this funding set; refusing to broadcast (the DID sat would be wrong).',
      mismatchDetails);
  }
  const output0 = parsed.getOutput(0);
  // TransactionInput.txid is stored in the same display-order hex convention as
  // Utxo.txid (verified: fromRaw round-trips it unreversed), so a direct hex compare is correct.
  // ORDER matters, not just membership: the DID sat is the first sat of input[0].
  const inputMatches = outpoints.every((expected, i) => {
    const input = parsed.getInput(i);
    const txidHex = Buffer.from(input.txid ?? new Uint8Array()).toString('hex').toLowerCase();
    return `${txidHex}:${input.index}` === expected && input.sequence === template.getInput(i).sequence;
  });
  const expectedCommitScriptHex = scriptPubKeyForAddress(commit.commitAddress, network);
  const output0ScriptHex = Buffer.from(output0.script ?? new Uint8Array()).toString('hex');
  const outputMatches = output0.amount === BigInt(commit.commitAmount) && output0ScriptHex === expectedCommitScriptHex;
  const allOutputsMatch = Array.from({ length: template.outputsLength }, (_, index) => {
    const actual = parsed.getOutput(index);
    const expected = template.getOutput(index);
    return actual.amount === expected.amount && Buffer.from(actual.script ?? []).equals(Buffer.from(expected.script ?? []));
  }).every(Boolean);
  if (!inputMatches || !outputMatches || !allOutputsMatch) {
    throw new StructuredError('COMMIT_TX_MISMATCH',
      'The signed commit does not match the commit built for this funding set; refusing to broadcast (the DID sat would be wrong).',
      mismatchDetails);
  }

  // 6) Build + self-sign the reveal spending the commit output (vout 0) BEFORE
  // broadcasting anything, so a construction failure costs no on-chain funds.
  const reveal = await createRevealTransaction({
    commitTxId, commitVout: 0, commitAmount: commit.commitAmount,
    revealPrivateKey: commit.revealPrivateKey, revealPublicKey: commit.revealPublicKey,
    inscriptionScript: commit.inscriptionScript,
    destinationAddress: changeAddress, feeRate, network
  });

  return {
    version: 1, network, satoshi, inscriptionId: reveal.inscriptionId,
    commitTxId, revealTxId: reveal.revealTxId,
    signedCommitHex: signedCommit, revealTxHex: reveal.revealTxHex,
    fundingUtxos: fundingUtxos.map((utxo) => ({ ...utxo })), changeAddress
  };
}
