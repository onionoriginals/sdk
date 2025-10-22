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
import { schnorr } from '@noble/curves/secp256k1';
import { Utxo } from '../../types/bitcoin.js';
import { calculateFee } from '../fee-calculation.js';
import { selectUtxos, SimpleUtxoSelectionOptions } from '../utxo-selection.js';

// Define minimum dust limit (satoshis)
const MIN_DUST_LIMIT = 546;

// Maximum iterations for UTXO reselection to prevent infinite loops
const MAX_SELECTION_ITERATIONS = 5;

/**
 * Bitcoin network type for @scure/btc-signer
 */
type BitcoinNetwork = 'mainnet' | 'testnet' | 'regtest' | 'signet';

/**
 * Get @scure/btc-signer network configuration
 */
function getScureNetwork(network: BitcoinNetwork): typeof btc.NETWORK {
  switch (network) {
    case 'mainnet':
      return btc.NETWORK;
    case 'testnet':
    case 'signet':
    case 'regtest':
      return btc.TEST_NETWORK;
    default:
      return btc.NETWORK;
  }
}

/**
 * Validates that a UTXO has all required fields for spending
 *
 * @param utxo - The UTXO to validate
 * @returns true if the UTXO is valid and spendable, false otherwise
 */
function isValidSpendableUtxo(utxo: Utxo): boolean {
  return !!(
    utxo.txid &&
    typeof utxo.vout === 'number' &&
    utxo.value > 0 &&
    utxo.scriptPubKey &&
    utxo.scriptPubKey.length > 0
  );
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
 * Estimates the size of a commit transaction
 *
 * @param inputCount - Number of transaction inputs
 * @param outputCount - Number of transaction outputs (including commit and change)
 * @returns Estimated transaction size in virtual bytes
 */
function estimateCommitTxSize(inputCount: number, outputCount: number): number {
  // Transaction overhead
  const overhead = 10.5;

  // P2WPKH inputs (assuming most common case)
  const inputSize = 68 * inputCount;

  // P2TR output for commit and P2WPKH for change
  const commitOutputSize = 43; // P2TR output
  const changeOutputSize = outputCount > 1 ? 31 * (outputCount - 1) : 0; // P2WPKH outputs for change

  return Math.ceil(overhead + inputSize + commitOutputSize + changeOutputSize);
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

  if (feeRate <= 0) {
    throw new Error(`Invalid fee rate: ${feeRate}`);
  }

  // CRITICAL: Pre-filter UTXOs to ensure all have valid scriptPubKey
  // This prevents silent failures where UTXOs are selected but can't be spent
  const validUtxos = utxos.filter(isValidSpendableUtxo);

  if (validUtxos.length === 0) {
    const invalidCount = utxos.length;
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

    throw new Error(
      `No valid spendable UTXOs available. ${invalidCount} UTXO(s) provided but all are invalid:\n` +
      invalidReasons.slice(0, 5).join('\n') +
      (invalidReasons.length > 5 ? `\n... and ${invalidReasons.length - 5} more` : '')
    );
  }

  // Log filtered UTXOs for debugging
  if (validUtxos.length < utxos.length) {
    const filteredCount = utxos.length - validUtxos.length;
    console.warn(`Filtered out ${filteredCount} invalid UTXO(s). ${validUtxos.length} valid UTXO(s) remain.`);
  }

  // Step 1: Create the inscription object
  const tags: ordinals.Tags = {
    contentType
  };

  // Add metadata if provided
  if (metadata && Object.keys(metadata).length > 0) {
    tags.metadata = metadata;
  }

  // Add pointer if provided
  if (typeof pointer !== 'undefined') {
    (tags as any).pointer = pointer;
  }

  const inscription: ordinals.Inscription = {
    tags,
    body: new Uint8Array(content)
  };

  // Step 2: Generate a reveal keypair
  // Use random private key for reveal transaction
  const revealPrivateKey = schnorr.utils.randomPrivateKey();
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

  // Step 5: Calculate minimum amount needed for the commit output
  const commitOutputValue = Math.max(minimumCommitAmount, MIN_DUST_LIMIT);

  // Step 6: Iterative UTXO selection with fee recalculation
  // This ensures that after we know the actual input count, we have enough funds
  let selectedUtxos: Utxo[] = [];
  let totalInputValue = 0;
  let estimatedFee = 0;
  let iteration = 0;

  // Start with initial estimate (1 input, 2 outputs)
  let targetAmount = commitOutputValue + Number(calculateFee(estimateCommitTxSize(1, 2), feeRate));

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

    // Calculate accurate fee based on actual selected input count
    // Assume 2 outputs (commit + change) for now - we'll adjust later if no change
    const actualInputCount = selectedUtxos.length;
    const estimatedVBytes = estimateCommitTxSize(actualInputCount, 2);
    estimatedFee = Number(calculateFee(estimatedVBytes, feeRate));

    // Check if we need to account for no change output
    const potentialChange = totalInputValue - commitOutputValue - estimatedFee;
    let finalOutputCount = 2;

    if (potentialChange < MIN_DUST_LIMIT) {
      // No change output, recalculate fee with 1 output
      finalOutputCount = 1;
      const adjustedVBytes = estimateCommitTxSize(actualInputCount, finalOutputCount);
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
  const actualInputCount = tx.inputsLength;

  // Determine if we'll have a change output
  const preliminaryChange = totalInputValue - commitOutputValue - estimatedFee;
  const willHaveChange = preliminaryChange >= MIN_DUST_LIMIT;
  const finalOutputCount = willHaveChange ? 2 : 1;

  // Calculate final fee with correct output count
  const finalVBytes = estimateCommitTxSize(actualInputCount, finalOutputCount);
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

  // Step 10: Add change output if above dust limit
  if (finalChange >= MIN_DUST_LIMIT) {
    tx.addOutputAddress(
      changeAddress,
      BigInt(finalChange),
      scureNetwork
    );
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
