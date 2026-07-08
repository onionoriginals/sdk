/**
 * Commit Transaction Processing for Ordinals
 *
 * This module implements the commit transaction process for ordinals inscriptions.
 * It handles the generation of the commit address and preparation of the commit transaction.
 *
 * Ported from legacy ordinalsplus transaction infrastructure.
 */

import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Utxo, ResourceUtxo } from '../../types/bitcoin.js';
import { calculateFee } from '../fee-calculation.js';
import { selectUtxos, SimpleUtxoSelectionOptions } from '../utxo-selection.js';
import { isSegwitScriptPubKey, inputVBytesForScriptPubKey, outputVBytesForAddress } from '../utxo.js';
import { validateBitcoinAddress } from '../../utils/bitcoin-address.js';
import { scriptPubKeyForAddress } from '../transfer.js';

// Define minimum dust limit (satoshis)
const MIN_DUST_LIMIT = 546;

// Maximum iterations for UTXO reselection to prevent infinite loops
const MAX_SELECTION_ITERATIONS = 5;

/**
 * Bitcoin network type for @scure/btc-signer
 */
type BitcoinNetwork = 'mainnet' | 'testnet' | 'regtest' | 'signet';

// Regtest uses the bech32 prefix 'bcrt', which is not covered by
// @scure/btc-signer's built-in TEST_NETWORK (which uses 'tb'). We define a
// minimal network object so that address <-> script derivation works for
// regtest addresses (matching packages/sdk/src/bitcoin/transfer.ts).
// BTC_NETWORK shape is { bech32, pubKeyHash, scriptHash, wif }.
const REGTEST_NETWORK: typeof btc.NETWORK = {
  bech32: 'bcrt',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

/**
 * Get @scure/btc-signer network configuration
 */
export function getScureNetwork(network: BitcoinNetwork): typeof btc.NETWORK {
  switch (network) {
    case 'mainnet':
      return btc.NETWORK;
    case 'regtest':
      return REGTEST_NETWORK;
    case 'testnet':
    case 'signet':
      return btc.TEST_NETWORK;
    default: {
      // Unknown network: fail loudly rather than silently assuming mainnet
      // (real funds). The `never` assignment also makes any future addition to
      // BitcoinNetwork a compile error until it is explicitly handled above.
      const exhaustiveCheck: never = network;
      throw new Error(`Unsupported Bitcoin network: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Parameters for creating a commit transaction
 */
export interface CommitTransactionParams {
  /** Inscription content as Buffer */
  content: Buffer;
  /** MIME type of the content (e.g., 'text/plain', 'image/png') */
  contentType: string;
  /** Available UTXOs to fund the transaction */
  utxos: Utxo[];
  /** Address to send change back to */
  changeAddress: string;
  /** Fee rate in sats/vB */
  feeRate: number;
  /** Bitcoin network configuration */
  network: BitcoinNetwork;
  /** Optional minimum amount for the commit output */
  minimumCommitAmount?: number;
  /** Optional metadata for the inscription */
  metadata?: Record<string, unknown>;
  /** Optional pointer to target specific satoshi */
  pointer?: number;
}

/**
 * Result of the commit transaction creation
 */
export interface CommitTransactionResult {
  /** P2TR address for the commit output */
  commitAddress: string;
  /** Base64-encoded PSBT for the commit transaction */
  commitPsbtBase64: string;
  /** Raw PSBT object for commit transaction (for direct manipulation) */
  commitPsbt: btc.Transaction;
  /** The exact amount sent to the commit output */
  commitAmount: number;
  /** Selected UTXOs for the transaction */
  selectedUtxos: Utxo[];
  /** Fee information */
  fees: {
    /** Fee for the commit transaction in satoshis */
    commit: number;
  };
  /** Reveal private key (hex string) - needed for reveal transaction */
  revealPrivateKey: string;
  /** Reveal public key (hex string) */
  revealPublicKey: string;
  /** Inscription script for reveal transaction */
  inscriptionScript: {
    script: Uint8Array;
    controlBlock: Uint8Array;
    leafVersion: number;
  };
}

/**
 * Estimates the size of a commit transaction.
 *
 * Inputs are sized by script class (P2WPKH 68 vB, P2TR 57.5 vB, P2WSH a
 * conservative 120 vB) rather than assuming P2WPKH for every segwit input —
 * a 2-of-3 P2WSH input is ~105 vB, so the old flat 68 vB built commits that
 * paid below the requested fee rate and could stall in the mempool with the
 * reveal key stranded in memory (issue #344). When uncertain, overestimate.
 *
 * @param inputs - The UTXOs funding the transaction
 * @param outputCount - Number of transaction outputs (including commit and change)
 * @param changeOutputVBytes - Size of one change output, per the change address's script class
 * @returns Estimated transaction size in virtual bytes
 */
function estimateCommitTxSize(inputs: Utxo[], outputCount: number, changeOutputVBytes: number): number {
  // Transaction overhead
  const overhead = 10.5;

  const inputSize = inputs.reduce((sum, u) => sum + inputVBytesForScriptPubKey(u.scriptPubKey), 0);

  // P2TR output for commit; change output sized by the change address type
  const commitOutputSize = 43; // P2TR output
  const changeOutputSize = outputCount > 1 ? changeOutputVBytes * (outputCount - 1) : 0;

  return Math.ceil(overhead + inputSize + commitOutputSize + changeOutputSize);
}

/**
 * Estimates the size of the reveal transaction that will spend the commit
 * output: one taproot script-path input whose witness carries the actual
 * inscription envelope script (content, contentType, metadata, pointer),
 * the schnorr signature and the control block (all witness-discounted 4x),
 * and one P2TR output for the inscribed satoshi.
 *
 * @param scriptLength - Serialized inscription leaf script length in bytes
 * @param controlBlockLength - Control block length in bytes
 * @returns Estimated reveal transaction size in virtual bytes
 */
function estimateRevealTxSize(scriptLength: number, controlBlockLength: number): number {
  const overhead = 10.5;
  const inputBase = 57.5; // taproot input without witness
  const outputSize = 43; // P2TR output
  const compactSize = (n: number): number => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
  // Witness stack (3 items): schnorr signature, envelope script, control
  // block — each prefixed by a CompactSize length, plus a CompactSize stack
  // item count. Omitting these underfunds the reveal once a script exceeds
  // 252 bytes (its length prefix grows to 3).
  const witnessBytes =
    1 + // stack item count (3 fits in 1 byte)
    1 + 64 + // signature length prefix + 64-byte schnorr signature
    compactSize(scriptLength) + scriptLength +
    compactSize(controlBlockLength) + controlBlockLength;
  return Math.ceil(overhead + inputBase + outputSize + witnessBytes / 4);
}

/**
 * Creates a commit transaction for an ordinals inscription
 *
 * This function:
 * 1. Validates and filters UTXOs to ensure they are spendable
 * 2. Creates an inscription with the provided content
 * 3. Generates a reveal keypair and script
 * 4. Creates a P2TR commit address
 * 5. Selects UTXOs to fund the transaction (with iterative reselection if needed)
 * 6. Builds a PSBT with commit output and change
 *
 * The function ensures that:
 * - All selected UTXOs have valid scriptPubKey fields
 * - Total input value always covers output value + fees
 * - UTXO selection is re-run if fee increases after accurate calculation
 *
 * @param params - Parameters for the commit transaction
 * @returns Complete information for the prepared commit transaction
 * @throws Error if no valid UTXOs are available or insufficient funds
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function createCommitTransaction(
  params: CommitTransactionParams
): Promise<CommitTransactionResult> {
  const {
    content,
    contentType,
    utxos,
    changeAddress,
    feeRate,
    network,
    minimumCommitAmount = MIN_DUST_LIMIT,
    metadata,
    pointer
  } = params;

  // Validate inputs
  if (!utxos || utxos.length === 0) {
    throw new Error('No UTXOs provided to fund the transaction.');
  }

  if (!content || content.length === 0) {
    throw new Error('Invalid inscription: missing content.');
  }

  if (!contentType) {
    throw new Error('Invalid inscription: missing content type.');
  }

  if (!changeAddress) {
    throw new Error('Change address is required.');
  }

  // Fail fast: validate the change address against the target network BEFORE any
  // expensive UTXO selection / fee calculation runs. Without this, a wrong-network
  // address (e.g. a testnet address on mainnet) is only rejected late inside
  // tx.addOutputAddress() with a cryptic @scure error, after work has been wasted.
  // Mirrors buildTransferTransaction in ../transfer.ts. validateBitcoinAddress
  // accepts 'mainnet' | 'regtest' | 'signet'; testnet shares signet's prefix.
  const validateNetwork: 'mainnet' | 'regtest' | 'signet' =
    network === 'testnet' ? 'signet' : network;
  validateBitcoinAddress(changeAddress, validateNetwork);

  if (feeRate <= 0) {
    throw new Error(`Invalid fee rate: ${feeRate}`);
  }

  // CRITICAL: Pre-filter UTXOs in two passes so error messages clearly distinguish
  // between structurally invalid UTXOs and those that are valid but protected from
  // being spent (locked or carrying an inscription/resource ordinal).

  // Pass 1: structural validity (txid, vout, value, scriptPubKey)
  function isStructurallyValid(utxo: Utxo): boolean {
    return !!(
      utxo.txid &&
      typeof utxo.vout === 'number' &&
      utxo.value > 0 &&
      utxo.scriptPubKey &&
      utxo.scriptPubKey.length > 0
    );
  }

  function isProtected(utxo: Utxo): boolean {
    return !!(
      utxo.locked ||
      (utxo.inscriptions && utxo.inscriptions.length > 0) ||
      (utxo as ResourceUtxo).hasResource === true
    );
  }

  const structurallyValid = utxos.filter(isStructurallyValid);
  const structurallyInvalidCount = utxos.length - structurallyValid.length;

  const unprotectedUtxos = structurallyValid.filter(utxo => !isProtected(utxo));
  const protectedCount = structurallyValid.length - unprotectedUtxos.length;

  // Pass 3: only segwit funding inputs are supported. The fee estimator
  // assumes ~68 vB witness inputs and signing supplies only witnessUtxo data,
  // so a legacy (P2PKH/P2SH) input would be under-fee'd (stuck tx) and
  // unsignable by @scure/btc-signer without nonWitnessUtxo.
  const validUtxos = unprotectedUtxos.filter(utxo => isSegwitScriptPubKey(utxo.scriptPubKey!));
  const legacyCount = unprotectedUtxos.length - validUtxos.length;

  if (validUtxos.length === 0) {
    const invalidReasons: string[] = [];

    utxos.forEach((utxo, idx) => {
      if (!utxo.scriptPubKey || utxo.scriptPubKey.length === 0) {
        invalidReasons.push(`UTXO ${idx} (${utxo.txid}:${utxo.vout}): missing scriptPubKey`);
      } else if (!utxo.txid) {
        invalidReasons.push(`UTXO ${idx}: missing txid`);
      } else if (typeof utxo.vout !== 'number') {
        invalidReasons.push(`UTXO ${idx} (${utxo.txid}): missing or invalid vout`);
      } else if (utxo.value <= 0) {
        invalidReasons.push(`UTXO ${idx} (${utxo.txid}:${utxo.vout}): invalid value (${utxo.value})`);
      }
    });

    const parts: string[] = [
      `No valid spendable UTXOs available. ${utxos.length} UTXO(s) provided but all are excluded.`
    ];
    if (structurallyInvalidCount > 0) {
      parts.push(
        `${structurallyInvalidCount} UTXO(s) are structurally invalid:\n` +
        invalidReasons.slice(0, 5).join('\n') +
        (invalidReasons.length > 5 ? `\n... and ${invalidReasons.length - 5} more` : '')
      );
    }
    if (protectedCount > 0) {
      parts.push(
        `${protectedCount} UTXO(s) are excluded because they carry inscriptions or are locked ` +
        `and cannot safely be used as fee inputs (spending them would destroy the inscription).`
      );
    }
    if (legacyCount > 0) {
      parts.push(
        `${legacyCount} UTXO(s) are excluded because they have non-segwit (legacy) scriptPubKeys. ` +
        `Only segwit funding UTXOs (P2WPKH/P2WSH/P2TR) are supported; fund the wallet with segwit UTXOs.`
      );
    }

    throw new Error(parts.join('\n'));
  }

  // Log filtered UTXOs for debugging so operators can act on the information
  if (structurallyInvalidCount > 0) {
    console.warn(
      `Filtered out ${structurallyInvalidCount} structurally invalid UTXO(s). ` +
      `${structurallyValid.length} structurally valid UTXO(s) remain.`
    );
  }
  if (protectedCount > 0) {
    console.warn(
      `Excluded ${protectedCount} UTXO(s) that carry inscriptions or are locked — ` +
      `these are protected from being spent as fee inputs. ` +
      `${validUtxos.length} spendable UTXO(s) remain.`
    );
  }
  if (legacyCount > 0) {
    console.warn(
      `Excluded ${legacyCount} UTXO(s) with non-segwit (legacy) scriptPubKeys — ` +
      `only segwit funding inputs are supported. ${validUtxos.length} spendable UTXO(s) remain.`
    );
  }

  // Step 1: Create the inscription object
  const tags: ordinals.Tags = {
    contentType
  };

  // Add metadata if provided
  if (metadata && Object.keys(metadata).length > 0) {
    tags.metadata = metadata;
  }

  // Add pointer if provided. micro-ordinals encodes the pointer tag as an
  // 8-byte bigint; passing a number makes p2tr_ord_reveal throw.
  if (typeof pointer !== 'undefined') {
    tags.pointer = BigInt(pointer);
  }

  const inscription: ordinals.Inscription = {
    tags,
    body: new Uint8Array(content)
  };

  // Step 2: Generate a reveal keypair
  // Use random private key for reveal transaction
  const revealPrivateKey = schnorr.utils.randomSecretKey();
  const revealPublicKey = schnorr.getPublicKey(revealPrivateKey);

  // Step 3: Create the inscription script tree using micro-ordinals
  const scriptTree = ordinals.p2tr_ord_reveal(revealPublicKey, [inscription]);

  // Step 4: Create P2TR address for the commit output
  const scureNetwork = getScureNetwork(network);

  // Create taproot output using the inscription script tree
  // Use the reveal public key as the internal key
  const taprootPayment = btc.p2tr(
    revealPublicKey, // internal key
    scriptTree, // script tree
    scureNetwork,
    false, // allowUnknownOutputs
    [ordinals.OutOrdinalReveal] // customScripts
  );

  if (!taprootPayment.address) {
    throw new Error('Failed to generate P2TR commit address');
  }

  const commitAddress = taprootPayment.address;

  // Extract script information from the taproot payment
  if (!taprootPayment.leaves || taprootPayment.leaves.length === 0) {
    throw new Error('Failed to extract taproot leaves from P2TR payment');
  }

  const leaf = taprootPayment.leaves[0];
  const leafVersion = leaf.version ?? 0xc0;

  // Compute control block from leaf data
  // The control block is: version byte | internal key (32 bytes) | merkle path
  const controlBlock = btc.TaprootControlBlock.encode({
    version: leafVersion,
    internalKey: revealPublicKey,
    merklePath: leaf.path
  });

  // Step 5: Calculate minimum amount needed for the commit output.
  // The reveal transaction spends this output, pays its own fee, and must
  // still leave a >= dust postage output for the inscribed satoshi — so a
  // bare-dust commit output could never be revealed. Default to
  // postage + estimated reveal fee; an explicit minimumCommitAmount can
  // raise (but not lower) that floor.
  // Estimate from the real serialized leaf script (which embeds content,
  // contentType, metadata and pointer tags) so large metadata or MIME types
  // cannot silently underfund the reveal.
  const revealFee = Number(calculateFee(estimateRevealTxSize(leaf.script.length, controlBlock.length), feeRate));
  const requiredForReveal = MIN_DUST_LIMIT + revealFee;
  const commitOutputValue = Math.max(minimumCommitAmount, requiredForReveal);

  // Step 6: Iterative UTXO selection with fee recalculation
  // This ensures that after we know the actual input count, we have enough funds
  let selectedUtxos: Utxo[] = [];
  let totalInputValue = 0;
  let estimatedFee = 0;
  let iteration = 0;

  // Change output sized by the change address's script class (P2WPKH 31 vB,
  // P2TR/P2WSH 43 vB) instead of a flat P2WPKH assumption.
  const changeOutputVBytes = outputVBytesForAddress(changeAddress);

  // Start with initial estimate (1 input, 2 outputs). The input is not known
  // yet, so seed with the widest input class present among the candidates —
  // a conservative seed only affects the first selection pass; the loop
  // below re-estimates from the actually selected UTXOs.
  const widestInputVBytes = Math.max(...validUtxos.map(u => inputVBytesForScriptPubKey(u.scriptPubKey)));
  const initialVBytes = Math.ceil(10.5 + widestInputVBytes + 43 + changeOutputVBytes);
  let targetAmount = commitOutputValue + Number(calculateFee(initialVBytes, feeRate));

  while (iteration < MAX_SELECTION_ITERATIONS) {
    iteration++;

    // Select UTXOs based on current target amount
    const options: SimpleUtxoSelectionOptions = {
      targetAmount
    };

    try {
      const selectionResult = selectUtxos(validUtxos, options);
      selectedUtxos = selectionResult.selectedUtxos;
      totalInputValue = selectionResult.totalInputValue;
    } catch (error) {
      throw new Error(
        `Insufficient funds. Need ${targetAmount} sats for commit output (${commitOutputValue} sats) and estimated fees. ` +
        `Available: ${validUtxos.reduce((sum, u) => sum + u.value, 0)} sats from ${validUtxos.length} valid UTXO(s). ` +
        `${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    // Calculate accurate fee based on the actually selected inputs (sized by
    // script class). Assume 2 outputs (commit + change) for now - we'll
    // adjust later if no change
    const estimatedVBytes = estimateCommitTxSize(selectedUtxos, 2, changeOutputVBytes);
    estimatedFee = Number(calculateFee(estimatedVBytes, feeRate));

    // Check if we need to account for no change output
    const potentialChange = totalInputValue - commitOutputValue - estimatedFee;
    let finalOutputCount = 2;

    if (potentialChange < MIN_DUST_LIMIT) {
      // No change output, recalculate fee with 1 output
      finalOutputCount = 1;
      const adjustedVBytes = estimateCommitTxSize(selectedUtxos, finalOutputCount, changeOutputVBytes);
      estimatedFee = Number(calculateFee(adjustedVBytes, feeRate));
    }

    // Check if we have enough funds with the accurate fee calculation
    const requiredTotal = commitOutputValue + estimatedFee;

    if (totalInputValue >= requiredTotal) {
      // We have enough funds, break out of loop
      break;
    }

    // Not enough funds, need to reselect with higher target
    // Add a small buffer (5%) to account for potential fee variations
    targetAmount = Math.ceil(requiredTotal * 1.05);

    if (iteration >= MAX_SELECTION_ITERATIONS) {
      throw new Error(
        `Unable to select sufficient UTXOs after ${MAX_SELECTION_ITERATIONS} iterations. ` +
        `Required: ${requiredTotal} sats (commit: ${commitOutputValue}, fee: ${estimatedFee}), ` +
        `Selected: ${totalInputValue} sats from ${selectedUtxos.length} UTXO(s). ` +
        `Total available: ${validUtxos.reduce((sum, u) => sum + u.value, 0)} sats from ${validUtxos.length} valid UTXO(s).`
      );
    }
  }

  // Final validation: ensure we have selected UTXOs
  if (!selectedUtxos || selectedUtxos.length === 0) {
    throw new Error('No UTXOs selected for the transaction after selection process.');
  }

  // Step 7: Create transaction using @scure/btc-signer
  const tx = new btc.Transaction();

  // Add inputs - all selected UTXOs are already validated to have scriptPubKey
  for (const utxo of selectedUtxos) {
    // This check is now redundant due to pre-filtering, but kept as defense-in-depth
    if (!utxo.scriptPubKey) {
      throw new Error(
        `CRITICAL ERROR: Selected UTXO ${utxo.txid}:${utxo.vout} is missing scriptPubKey. ` +
        `This should never happen due to pre-filtering. Please report this bug.`
      );
    }
    // Defense-in-depth: a non-segwit input added with only witnessUtxo data
    // cannot be validly signed and its fee was estimated at segwit size.
    if (!isSegwitScriptPubKey(utxo.scriptPubKey)) {
      throw new Error(
        `Selected UTXO ${utxo.txid}:${utxo.vout} has a non-segwit (legacy) scriptPubKey. ` +
        `Only segwit funding UTXOs (P2WPKH/P2WSH/P2TR) are supported.`
      );
    }

    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: Buffer.from(utxo.scriptPubKey, 'hex'),
        amount: BigInt(utxo.value)
      }
    });
  }

  // Verify input count matches selected UTXOs
  if (tx.inputsLength !== selectedUtxos.length) {
    throw new Error(
      `Input count mismatch: expected ${selectedUtxos.length} inputs but transaction has ${tx.inputsLength}. ` +
      `This indicates a critical error in transaction construction.`
    );
  }

  // Step 8: Calculate final fee based on actual transaction structure

  // Determine if we'll have a change output
  const preliminaryChange = totalInputValue - commitOutputValue - estimatedFee;
  const willHaveChange = preliminaryChange >= MIN_DUST_LIMIT;
  const finalOutputCount = willHaveChange ? 2 : 1;

  // Calculate final fee with correct output count
  const finalVBytes = estimateCommitTxSize(selectedUtxos, finalOutputCount, changeOutputVBytes);
  const finalFee = Number(calculateFee(finalVBytes, feeRate));

  // CRITICAL: Final validation that inputs cover outputs + fees
  const finalChange = totalInputValue - commitOutputValue - finalFee;

  if (finalChange < 0) {
    throw new Error(
      `CRITICAL ERROR: Outputs exceed inputs! ` +
      `Inputs: ${totalInputValue} sats, ` +
      `Outputs: ${commitOutputValue} sats (commit) + ${finalFee} sats (fee) = ${commitOutputValue + finalFee} sats. ` +
      `Deficit: ${Math.abs(finalChange)} sats. ` +
      `This should never happen due to iterative selection. Please report this bug.`
    );
  }

  // Step 9: Add the commit output using the P2TR address
  tx.addOutputAddress(
    commitAddress,
    BigInt(commitOutputValue),
    scureNetwork
  );

  // Step 10: Add change output if above dust limit. The change script is
  // derived via scriptPubKeyForAddress rather than tx.addOutputAddress:
  // validateBitcoinAddress deliberately accepts testnet-format (`tb1…`)
  // change addresses on regtest, but addOutputAddress decodes strictly
  // against `bcrt` and would throw a cryptic @scure error here — after all
  // the keygen/selection/fee work the early validation exists to protect
  // (issue #351). scriptPubKeyForAddress carries the same regtest→testnet
  // decode fallback transfer.ts already uses.
  if (finalChange >= MIN_DUST_LIMIT) {
    tx.addOutput({
      script: Buffer.from(scriptPubKeyForAddress(changeAddress, network), 'hex'),
      amount: BigInt(finalChange)
    });
  } else if (finalChange > 0) {
    // If change is below dust limit, it's effectively added to the fee
    console.log(
      `Change amount ${finalChange} sats is below dust limit (${MIN_DUST_LIMIT} sats), adding to fee. ` +
      `Final fee: ${finalFee + finalChange} sats.`
    );
  }

  // Step 11: Get the PSBT as base64
  const txPsbt = tx.toPSBT();
  const commitPsbtBase64 = typeof txPsbt === 'string' ? txPsbt : Buffer.from(txPsbt).toString('base64');

  return {
    commitAddress,
    commitPsbtBase64,
    commitPsbt: tx,
    commitAmount: commitOutputValue,
    selectedUtxos,
    fees: {
      // Include dust in final fee if no change output
      commit: finalChange >= MIN_DUST_LIMIT ? finalFee : finalFee + finalChange
    },
    revealPrivateKey: Buffer.from(revealPrivateKey).toString('hex'),
    revealPublicKey: Buffer.from(revealPublicKey).toString('hex'),
    inscriptionScript: {
      script: leaf.script,
      controlBlock,
      leafVersion
    }
  };
}
