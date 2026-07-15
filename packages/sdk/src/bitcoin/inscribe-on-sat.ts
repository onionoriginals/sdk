import { Utxo } from '../types/bitcoin.js';
import { BitcoinSigner } from '../types/common.js';
import { OrdinalsProvider } from '../adapters/types.js';
import { StructuredError } from '../utils/telemetry.js';
import { validateSatoshiNumber } from '../utils/satoshi-validation.js';
import { createCommitTransaction, createRevealTransaction } from './transactions/commit.js';

export interface InscribeOnSatParams {
  buildContent: (satoshi: string) => Promise<{ content: Buffer; contentType: string; metadata?: Record<string, unknown> }>;
  fundingUtxo: Utxo;
  satSigner: BitcoinSigner;
  changeAddress: string;
  feeRate: number;
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  provider: OrdinalsProvider;
}

export interface InscribeOnSatResult {
  satoshi: string;          // the derived, verified DID sat
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
}

/**
 * Orchestrates a genesis did:btco inscription targeted at a caller-selected
 * funding output's sat. The sat is DERIVED from the provider's sat index
 * (never caller-asserted), and the landed inscription is verified fail-closed
 * against that derived sat before returning.
 */
export async function inscribeOnSat(params: InscribeOnSatParams): Promise<InscribeOnSatResult> {
  const { buildContent, fundingUtxo, satSigner, changeAddress, feeRate, network, provider } = params;

  if (typeof provider.getFirstSatOfOutput !== 'function') {
    throw new StructuredError('SAT_INDEX_UNSUPPORTED',
      'SAT_INDEX_UNSUPPORTED: the ordinals provider cannot resolve the funding output\'s sat (no sat index); cannot select the did:btco sat.');
  }

  // 1) Derive the authoritative DID sat from the provider.
  const satoshi = await provider.getFirstSatOfOutput({ txid: fundingUtxo.txid, vout: fundingUtxo.vout });
  const v = validateSatoshiNumber(satoshi);
  if (!v.valid) throw new StructuredError('INVALID_SATOSHI', `Provider returned invalid sat: ${v.error}`);

  // 2) Build content embedding did:btco:<sat> (caller's closure appends the CEL migrate event).
  const { content, contentType, metadata } = await buildContent(satoshi);

  // 3) Unsigned commit: single funding input, inscription output at vout 0, no pointer.
  const commit = await createCommitTransaction({
    content, contentType, metadata,
    utxos: [fundingUtxo], changeAddress, feeRate, network
  });

  // 4) Caller signs the commit; broadcast it.
  const signedCommit = await satSigner.signCommitPsbt(commit.commitPsbtBase64);
  const commitTxId = await provider.broadcastTransaction(signedCommit);

  // 5) Build + self-sign the reveal spending the commit output (vout 0); broadcast.
  const reveal = await createRevealTransaction({
    commitTxId, commitVout: 0, commitAmount: commit.commitAmount,
    revealPrivateKey: commit.revealPrivateKey, revealPublicKey: commit.revealPublicKey,
    inscriptionScript: commit.inscriptionScript,
    destinationAddress: changeAddress, feeRate, network
  });
  const revealTxId = await provider.broadcastTransaction(reveal.revealTxHex);

  // 6) Fail-closed: the landed inscription MUST sit on the derived sat.
  const landed = await provider.getInscriptionById(reveal.inscriptionId);
  if (!landed || String(landed.satoshi ?? '') !== satoshi) {
    throw new StructuredError('SAT_MISMATCH',
      `SAT_MISMATCH: inscription ${reveal.inscriptionId} landed on sat ${landed?.satoshi ?? 'unknown'}, expected ${satoshi}; the did:btco identity would be wrong.`);
  }

  return { satoshi, inscriptionId: reveal.inscriptionId, commitTxId, revealTxId };
}
