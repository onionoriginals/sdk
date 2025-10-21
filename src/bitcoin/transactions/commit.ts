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
 * 1. Creates an inscription with the provided content
 * 2. Generates a reveal keypair and script
 * 3. Creates a P2TR commit address
 * 4. Selects UTXOs to fund the transaction
 * 5. Builds a PSBT with commit output and change
 *
 * @param params - Parameters for the commit transaction
 * @returns Complete information for the prepared commit transaction
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

  // Step 6: Estimate commit transaction size for initial fee calculation
  const estimatedCommitVBytes = estimateCommitTxSize(1, 2); // 1 input, 2 outputs (commit + change)
  const estimatedCommitFee = Number(calculateFee(estimatedCommitVBytes, feeRate));

  // Calculate total amount needed
  const totalNeeded = commitOutputValue + estimatedCommitFee;

  // Step 7: Select UTXOs to fund the transaction
  const options: SimpleUtxoSelectionOptions = {
    targetAmount: totalNeeded
  };

  let selectedUtxos: Utxo[];
  let totalInputValue: number;

  try {
    const selectionResult = selectUtxos(utxos, options);
    selectedUtxos = selectionResult.selectedUtxos;
    totalInputValue = selectionResult.totalInputValue;
  } catch (error) {
    throw new Error(`Insufficient funds. Need ${totalNeeded} sats for commit output and fees. ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  if (!selectedUtxos || selectedUtxos.length === 0) {
    throw new Error('No UTXOs selected for the transaction.');
  }

  // Step 8: Create transaction using @scure/btc-signer
  const tx = new btc.Transaction();

  // Add inputs
  for (const utxo of selectedUtxos) {
    if (!utxo.scriptPubKey) {
      console.warn(`Skipping UTXO ${utxo.txid}:${utxo.vout} due to missing scriptPubKey.`);
      continue;
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

  // More accurate fee calculation now that we know exact input count
  const actualCommitVBytes = estimateCommitTxSize(tx.inputsLength, 2); // 2 outputs (commit + change)
  const recalculatedCommitFee = Number(calculateFee(actualCommitVBytes, feeRate));

  // Step 9: Add the commit output using the P2TR address
  tx.addOutputAddress(
    commitAddress,
    BigInt(commitOutputValue),
    scureNetwork
  );

  // Step 10: Calculate change amount
  const changeAmount = totalInputValue - commitOutputValue - recalculatedCommitFee;

  // Add change output if above dust limit
  if (changeAmount >= MIN_DUST_LIMIT) {
    tx.addOutputAddress(
      changeAddress,
      BigInt(changeAmount),
      scureNetwork
    );
  } else if (changeAmount > 0) {
    // If change is below dust limit, it's effectively added to the fee
    console.log(`Change amount ${changeAmount} is below dust limit, adding to fee.`);
  }

  // Final fee calculation (includes any dust amount added to fee)
  const finalFee = totalInputValue - commitOutputValue -
    (changeAmount >= MIN_DUST_LIMIT ? changeAmount : 0);

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
      commit: finalFee
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
