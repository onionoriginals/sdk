import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { equalBytes } from '@noble/curves/utils.js';
import { OutOrdinalReveal, parseInscriptions } from 'micro-ordinals';
import { StructuredError, validateSatoshiNumber } from '@originals/cel';
import type { OrdinalsProvider } from '../adapters/types.js';
import type { Utxo } from '../types/bitcoin.js';
import type { InscribeOnSatResult } from './inscribe-on-sat.js';
import { scriptPubKeyForAddress } from './transfer.js';

/** JSON-serializable recovery bytes; keep this record private like any signed spending transaction. */
export interface PreparedInscriptionOnSat {
  version: 1;
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  satoshi: string;
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
  signedCommitHex: string;
  revealTxHex: string;
  fundingUtxos: Utxo[];
  changeAddress: string;
}

export type InscriptionBroadcastState = 'commit_broadcast' | 'reveal_broadcast' |
  'commit_broadcast_unknown' | 'reveal_broadcast_unknown';

export interface InscriptionRecoveryRecord {
  /** The locally computed commit txid. */
  recoveryId: string;
  prepared: PreparedInscriptionOnSat;
  broadcast: 'prepared' | InscriptionBroadcastState;
}

export interface InscriptionRecoveryStore {
  /** Atomically persist the complete record. Resolve only once it survives process termination. */
  save(record: InscriptionRecoveryRecord): Promise<void>;
  load(recoveryId: string): Promise<InscriptionRecoveryRecord | undefined>;
}

function samePrepared(a: PreparedInscriptionOnSat, b: PreparedInscriptionOnSat): boolean {
  const fields = ['version', 'network', 'satoshi', 'inscriptionId', 'commitTxId', 'revealTxId', 'signedCommitHex', 'revealTxHex', 'changeAddress'] as const;
  return fields.every((field) => a[field] === b[field]) && a.fundingUtxos.length === b.fundingUtxos.length &&
    a.fundingUtxos.every((utxo, index) => {
      const other = b.fundingUtxos[index];
      return utxo.txid === other.txid && utxo.vout === other.vout && utxo.value === other.value && utxo.scriptPubKey === other.scriptPubKey;
    });
}

function invalid(message: string): never {
  throw new StructuredError('INVALID_INSCRIPTION_RECOVERY', message);
}

/** Validate the writer's single-leaf inscription spend; txids do not commit witness bytes. */
export function validateInscriptionReveal(commit: btc.Transaction, reveal: btc.Transaction): void {
  if (reveal.inputsLength !== 1 || reveal.getInput(0).index !== 0 ||
      Buffer.from(reveal.getInput(0).txid!).toString('hex') !== commit.id) {
    invalid('Recovery reveal must spend output zero of the exact commit.');
  }
  const witness = reveal.getInput(0).finalScriptWitness;
  if (!witness || witness.length !== 3) invalid('Recovery reveal must use the inscription script path.');
  const [signature, script, control] = witness;
  if (signature.length !== 64 || control.length !== 33 || (control[0] & 0xfe) !== 0xc0) {
    invalid('Recovery reveal must use the original single-leaf tapscript and default signature hash.');
  }
  const decoded = btc.Script.decode(script);
  const inscriptions = parseInscriptions(decoded, true);
  const publicKey = decoded[0];
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32 || inscriptions?.length !== 1) {
    invalid('Recovery reveal must contain exactly one inscription.');
  }
  const payment = btc.p2tr(control.slice(1), { type: 'tr', script }, undefined, false, [OutOrdinalReveal]);
  const expectedControl = btc.TaprootControlBlock.encode(payment.tapLeafScript![0][0]);
  const output = commit.getOutput(0);
  if (!output.script || output.amount === undefined || output.amount <= 0n ||
      !equalBytes(output.script, payment.script) || !equalBytes(control, expectedControl)) {
    invalid('Recovery reveal witness does not open the committed Taproot output.');
  }
  const message = reveal.preimageWitnessV1(0, [output.script], btc.SigHash.DEFAULT, [output.amount], undefined, script, 0xc0);
  if (!schnorr.verify(signature, message, publicKey)) invalid('Recovery reveal signature is invalid.');
}

/** Check persisted identities and funding order before using stored spending bytes. */
function validate(prepared: PreparedInscriptionOnSat): void {
  if (!prepared || prepared.version !== 1 || !['mainnet', 'testnet', 'regtest', 'signet'].includes(prepared.network) ||
      !validateSatoshiNumber(prepared.satoshi).valid || !Array.isArray(prepared.fundingUtxos) || !prepared.fundingUtxos.length) {
    invalid('Invalid prepared inscription schema.');
  }
  try {
    for (const hex of [prepared.signedCommitHex, prepared.revealTxHex]) {
      if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) invalid('Recovery transactions must be exact hexadecimal bytes.');
    }
    const options = { allowUnknownInputs: true, allowUnknownOutputs: true };
    const commit = btc.Transaction.fromRaw(Buffer.from(prepared.signedCommitHex, 'hex'), options);
    const reveal = btc.Transaction.fromRaw(Buffer.from(prepared.revealTxHex, 'hex'), options);
    if (commit.id !== prepared.commitTxId || reveal.id !== prepared.revealTxId || prepared.inscriptionId !== `${reveal.id}i0`) {
      invalid('Recovery identities do not match the locally computed transaction ids.');
    }
    if (reveal.inputsLength !== 1 || reveal.getInput(0).index !== 0 ||
        Buffer.from(reveal.getInput(0).txid!).toString('hex') !== commit.id) {
      invalid('Recovery reveal must spend output zero of the exact commit.');
    }
    if (commit.inputsLength !== prepared.fundingUtxos.length || prepared.fundingUtxos.some((utxo, index) => {
      const input = commit.getInput(index);
      return Buffer.from(input.txid!).toString('hex') !== utxo.txid.toLowerCase() || input.index !== utxo.vout;
    })) invalid('Recovery funding order does not match the identity input.');
    const outpoints = prepared.fundingUtxos.map((u) => `${u.txid.toLowerCase()}:${u.vout}`);
    if (new Set(outpoints).size !== outpoints.length) invalid('Recovery funding inputs contain duplicates.');
    if (reveal.outputsLength !== 1 || Buffer.from(reveal.getOutput(0).script!).toString('hex') !==
        scriptPubKeyForAddress(prepared.changeAddress, prepared.network)) invalid('Recovery reveal destination does not match.');
    validateInscriptionReveal(commit, reveal);
  } catch (error) {
    if (error instanceof StructuredError) throw error;
    invalid(`Cannot parse recovery transactions: ${error instanceof Error ? error.message : 'Unknown transaction parse failure'}`);
  }
}

function result(record: InscriptionRecoveryRecord, error?: unknown): InscribeOnSatResult {
  const { prepared, recoveryId } = record;
  if (record.broadcast === 'prepared') invalid('An unsubmitted record cannot report a broadcast result.');
  return {
    satoshi: prepared.satoshi, inscriptionId: prepared.inscriptionId,
    commitTxId: prepared.commitTxId, revealTxId: prepared.revealTxId,
    broadcast: record.broadcast, recoveryId, prepared,
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown broadcast failure' })
  };
}

async function persist(store: InscriptionRecoveryStore | undefined, record: InscriptionRecoveryRecord): Promise<void> {
  if (!store) return;
  try { await store.save(structuredClone(record)); } catch (error) {
    throw new StructuredError('INSCRIPTION_RECOVERY_PERSIST_FAILED',
      `Could not persist inscription recovery: ${error instanceof Error ? error.message : String(error)}`,
      { recoveryId: record.recoveryId });
  }
}

async function isCurrentlyConfirmed(provider: OrdinalsProvider, txid: string): Promise<boolean> {
  try { return (await provider.getTransactionStatus(txid)).confirmed === true; }
  catch { return false; }
}

/** Submit only these exact bytes. Direct broadcasting requires a durable store, never an implicit memory fallback. */
export async function submitPreparedInscriptionOnSat(params: {
  prepared: PreparedInscriptionOnSat;
  provider: OrdinalsProvider;
  recoveryStore?: InscriptionRecoveryStore;
}): Promise<InscribeOnSatResult> {
  const { provider, recoveryStore } = params;
  const prepared = structuredClone(params.prepared);
  validate(prepared);
  if (!recoveryStore && typeof provider.submitInscription !== 'function') {
    throw new StructuredError('INSCRIPTION_RECOVERY_REQUIRED', 'Direct inscription broadcasting requires a durable recoveryStore.');
  }
  let record: InscriptionRecoveryRecord = { recoveryId: prepared.commitTxId, prepared, broadcast: 'prepared' };
  const saved = await recoveryStore?.load(record.recoveryId);
  if (saved) {
    validate(saved.prepared);
    if (saved.recoveryId !== record.recoveryId || !samePrepared(saved.prepared, prepared)) {
      invalid('A different signed pair or identity is already stored under this recovery id.');
    }
    if (!['prepared', 'commit_broadcast', 'reveal_broadcast', 'commit_broadcast_unknown', 'reveal_broadcast_unknown'].includes(saved.broadcast)) {
      invalid('Invalid persisted broadcast state.');
    }
    record = structuredClone(saved);
  }
  if (saved && record.broadcast !== 'prepared') {
    // A persisted acknowledgement describes an earlier submission, not present
    // chain state. Eviction/reorg can remove either transaction. Only a fresh
    // confirmed reveal lets us skip submitting the pair on this invocation.
    if (await isCurrentlyConfirmed(provider, prepared.revealTxId)) {
      record.broadcast = 'reveal_broadcast';
      try { await persist(recoveryStore, record); } catch (error) { return result(record, error); }
      return result(record);
    }
    // Unconfirmed status conflates absent and mempool; transport errors provide
    // no presence evidence either. Replaying the identical signed commit is
    // safe in both cases and does not create a new commitment or funding spend.
    record.broadcast = await isCurrentlyConfirmed(provider, prepared.commitTxId)
      ? 'commit_broadcast' : 'commit_broadcast_unknown';
  }
  // This write is the gate before ANY submission, including retries.
  await persist(recoveryStore, record);

  if (typeof provider.submitInscription === 'function') {
    record.broadcast = 'commit_broadcast_unknown';
    await persist(recoveryStore, record);
    try {
      const submitted = await provider.submitInscription({
        signedCommitHex: prepared.signedCommitHex, revealTxHex: prepared.revealTxHex,
        fundingUtxos: prepared.fundingUtxos, fundingUtxo: prepared.fundingUtxos[0], changeAddress: prepared.changeAddress
      });
      if (submitted.commitTxId !== prepared.commitTxId || submitted.revealTxId !== prepared.revealTxId) {
        throw new Error('Provider submission ids do not match the locally identified signed pair.');
      }
      if (submitted.status !== 'commit_broadcast' && submitted.status !== 'reveal_broadcast') {
        throw new Error('Provider submission status must explicitly acknowledge commit_broadcast or reveal_broadcast.');
      }
      record.broadcast = submitted.status;
    } catch (error) { return result(record, error); }
    try { await persist(recoveryStore, record); } catch (error) { return result(record, error); }
    return result(record);
  }

  if (record.broadcast === 'prepared' || record.broadcast === 'commit_broadcast_unknown') {
    record.broadcast = 'commit_broadcast_unknown';
    await persist(recoveryStore, record);
    try {
      const txid = await provider.broadcastTransaction(prepared.signedCommitHex);
      if (txid !== prepared.commitTxId) throw new Error('Provider commit id does not match the signed transaction.');
    } catch (error) {
      // Unknown/not-confirmed conflates absent and mempool in this provider API.
      // Only actual confirmation can independently resolve a lost acknowledgement.
      if (!await isCurrentlyConfirmed(provider, prepared.commitTxId)) return result(record, error);
    }
    record.broadcast = 'commit_broadcast';
  }
  record.broadcast = 'reveal_broadcast_unknown';
  // If this write fails, the previous durable record still contains both transactions.
  try { await persist(recoveryStore, record); } catch (error) { return result(record, error); }
  try {
    const txid = await provider.broadcastTransaction(prepared.revealTxHex);
    if (txid !== prepared.revealTxId) throw new Error('Provider reveal id does not match the signed transaction.');
  } catch (error) {
    if (!await isCurrentlyConfirmed(provider, prepared.revealTxId)) return result(record, error);
  }
  record.broadcast = 'reveal_broadcast';
  try { await persist(recoveryStore, record); } catch (error) { return result(record, error); }
  return result(record);
}

/** Resume from durable bytes without invoking a signer, sat lookup, or content builder. */
export async function resumeInscriptionOnSat(params: {
  recoveryId: string;
  provider: OrdinalsProvider;
  recoveryStore: InscriptionRecoveryStore;
}): Promise<InscribeOnSatResult> {
  const record = await params.recoveryStore.load(params.recoveryId);
  if (!record || record.recoveryId !== params.recoveryId) invalid('No matching inscription recovery record exists.');
  return submitPreparedInscriptionOnSat({ prepared: record.prepared, provider: params.provider, recoveryStore: params.recoveryStore });
}
