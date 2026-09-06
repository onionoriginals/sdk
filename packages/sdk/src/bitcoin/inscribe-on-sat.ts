import * as btc from '@scure/btc-signer';
import { Utxo } from '../types/bitcoin.js';
import { BitcoinSigner } from '../types/common.js';
import { OrdinalsProvider } from '../adapters/types.js';
import { StructuredError } from '@originals/cel';
import { validateSatoshiNumber } from '@originals/cel';
import { createCommitTransaction, createRevealTransaction } from './transactions/commit.js';
import { scriptPubKeyForAddress } from './transfer.js';

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
}

export interface InscribeOnSatResult {
  satoshi: string;          // the derived DID sat (from the provider's sat index)
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
  /**
   * How far broadcasting actually got.
   *
   * `'reveal_broadcast'` — both transactions reached the network; the
   * inscription exists.
   * `'commit_broadcast'` — the commit is on the network and the reveal is
   * persisted by the provider for rebroadcast. STILL A SUCCESS: it completes
   * without the caller re-signing anything, usually once the commit confirms.
   * But the inscription does NOT exist yet, so a caller must not announce one
   * or link to `revealTxId` — that transaction is not findable.
   *
   * This used to be dropped: `submitInscription` returns it, the value was not
   * captured, and callers had no way to tell the two apart. A UI built on that
   * told a creator their inscription was done and linked to a reveal txid that
   * 404'd.
   */
  broadcast: 'commit_broadcast' | 'reveal_broadcast';
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
 * committed funds are never stranded. The signer's returned commit is checked
 * (every input == the declared funding set in order, output[0]==the built
 * commit output) before that broadcast, so a buggy/malicious signer can't
 * silently redirect the DID sat.
 */
export async function inscribeOnSat(params: InscribeOnSatParams): Promise<InscribeOnSatResult> {
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
  // declared funding set (in order) and output[0]==the commit output
  // (amount + scriptPubKey) BEFORE broadcasting.
  // Also BOUND the shape: exactly the declared inputs in the declared order
  // (an extra/missing/reordered input either spends an unrelated UTXO or moves
  // the identity sat) and at most two outputs (the commit output at vout 0 plus
  // an optional change output — a third output could redirect funds to an
  // attacker). Both fail closed before any broadcast.
  const mismatchDetails = { fundingUtxos: outpoints, commitAmount: commit.commitAmount, commitAddress: commit.commitAddress };
  if (parsed.inputsLength !== fundingUtxos.length || parsed.outputsLength < 1 || parsed.outputsLength > 2) {
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
    return `${txidHex}:${input.index}` === expected;
  });
  const expectedCommitScriptHex = scriptPubKeyForAddress(commit.commitAddress, network);
  const output0ScriptHex = Buffer.from(output0.script ?? new Uint8Array()).toString('hex');
  const outputMatches = output0.amount === BigInt(commit.commitAmount) && output0ScriptHex === expectedCommitScriptHex;
  if (!inputMatches || !outputMatches) {
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

  // 7+8) Broadcast commit then reveal. When the provider offers the atomic
  // submitInscription seam, use it: the implementation persists BOTH signed
  // txs durably before broadcasting anything, so a caller that dies between
  // commit and reveal can never strand the committed funds (the reveal is
  // rebroadcast from the persisted copy). Otherwise fall back to the two
  // sequential broadcasts with in-memory recovery data.
  let broadcast: InscribeOnSatResult['broadcast'] = 'reveal_broadcast';
  if (typeof provider.submitInscription === 'function') {
    try {
      const submitted = await provider.submitInscription({
        signedCommitHex: signedCommit,
        revealTxHex: reveal.revealTxHex,
        fundingUtxos,
        // Legacy singular mirror: an implementation predating multi-input
        // reads the IDENTITY input here, never a random one.
        fundingUtxo: identityUtxo,
        changeAddress
      });
      // An implementation predating this field reports nothing; treat that as
      // the complete case it has always meant, rather than inventing doubt.
      if (submitted?.status === 'commit_broadcast') broadcast = 'commit_broadcast';
    } catch (e) {
      // Ambiguous by construction: the submit may have failed before anything
      // was persisted/broadcast (nothing spent) or after (server-side recovery
      // owns it). Attach the full recovery data either way so no funds path
      // depends on this process's memory surviving.
      throw new StructuredError('INSCRIPTION_SUBMIT_FAILED',
        `Submitting the signed commit+reveal pair failed: ${e instanceof Error ? e.message : String(e)}. ` +
        'If the submission reached the server it will complete the inscription from its persisted copy; ' +
        'otherwise nothing was broadcast and the funding UTXO is unspent.',
        {
          commitTxId, revealTxId: reveal.revealTxId, revealTxHex: reveal.revealTxHex,
          signedCommitHex: signedCommit, satoshi, inscriptionId: reveal.inscriptionId
        });
    }
  } else {
    // Broadcast the commit.
    await provider.broadcastTransaction(signedCommit);

    // Broadcast the reveal; on failure the commit is already on-chain, so
    // attach recovery data (rebroadcast revealTxHex to complete the inscription).
    try {
      await provider.broadcastTransaction(reveal.revealTxHex);
    } catch {
      throw new StructuredError('REVEAL_BROADCAST_FAILED',
        `Commit ${commitTxId} broadcast but the reveal failed; rebroadcast revealTxHex to recover the committed funds and complete the inscription.`,
        { commitTxId, revealTxId: reveal.revealTxId, revealTxHex: reveal.revealTxHex, satoshi, inscriptionId: reveal.inscriptionId });
    }
  }

  return { satoshi, inscriptionId: reveal.inscriptionId, commitTxId, revealTxId: reveal.revealTxId, broadcast };
}
