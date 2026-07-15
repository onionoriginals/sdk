import * as btc from '@scure/btc-signer';
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
  satoshi: string;          // the derived DID sat (from the provider's sat index)
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
}

/**
 * Orchestrates a genesis did:btco inscription targeted at a caller-selected
 * funding output's sat. FIRE-AND-FORGET: correctness rests on the provider's
 * honest sat index + deterministic tx construction, both verified at DERIVE
 * time — the DID sat is derived from the provider before anything is spent, and
 * the inscription is deterministically constructed to land on it. There is NO
 * post-broadcast re-check: on a real ord-indexed provider the inscription isn't
 * queryable until confirmed (minutes-hours), so a post-broadcast sat lookup
 * would spuriously fail after real BTC was spent. The caller owns confirmation
 * monitoring. Both txs are built (and the commit txid computed locally) BEFORE
 * broadcasting, and a post-commit reveal failure returns recovery data so the
 * committed funds are never stranded.
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

  // 4) Caller signs the commit; the return MUST be broadcast-ready tx hex.
  const signedCommit = await satSigner.signCommitPsbt(commit.commitPsbtBase64);

  // 5) Compute the commit txid LOCALLY from the signed tx. The funding input is
  // segwit, so the txid is witness-independent — never trust a provider-returned
  // txid to build the reveal's prevout.
  let commitTxId: string;
  try {
    const parsed = btc.Transaction.fromRaw(Buffer.from(signedCommit, 'hex'), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true
    });
    commitTxId = parsed.id;
  } catch (e) {
    throw new StructuredError('COMMIT_TX_INVALID',
      `Signer returned a commit transaction that could not be parsed as broadcast-ready hex: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 6) Build + self-sign the reveal spending the commit output (vout 0) BEFORE
  // broadcasting anything, so a construction failure costs no on-chain funds.
  const reveal = await createRevealTransaction({
    commitTxId, commitVout: 0, commitAmount: commit.commitAmount,
    revealPrivateKey: commit.revealPrivateKey, revealPublicKey: commit.revealPublicKey,
    inscriptionScript: commit.inscriptionScript,
    destinationAddress: changeAddress, feeRate, network
  });

  // 7) Broadcast the commit.
  await provider.broadcastTransaction(signedCommit);

  // 8) Broadcast the reveal; on failure the commit is already on-chain, so
  // attach recovery data (rebroadcast revealTxHex to complete the inscription).
  try {
    await provider.broadcastTransaction(reveal.revealTxHex);
  } catch (e) {
    throw new StructuredError('REVEAL_BROADCAST_FAILED',
      `Commit ${commitTxId} broadcast but the reveal failed; rebroadcast revealTxHex to recover the committed funds and complete the inscription.`,
      { commitTxId, revealTxId: reveal.revealTxId, revealTxHex: reveal.revealTxHex, satoshi });
  }

  return { satoshi, inscriptionId: reveal.inscriptionId, commitTxId, revealTxId: reveal.revealTxId };
}
