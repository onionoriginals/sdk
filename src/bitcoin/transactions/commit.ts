/**
 * Commit Transaction Processing for Ordinals
 * 
 * Faithfully ported from legacy ordinalsplus using micro-ordinals and @scure/btc-signer.
 * This is the working implementation - do not modify the approach.
 */

import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { schnorr } from '@noble/curves/secp256k1';
import { Utxo, DUST_LIMIT_SATS } from '../../types/bitcoin';
import { calculateFee } from '../fee-calculation';
import { selectUtxos } from '../utxo-selection';
import { getScureNetwork, BitcoinNetwork } from '../utils/networks';

// Define minimum dust limit (satoshis)
const MIN_DUST_LIMIT = DUST_LIMIT_SATS;

/**
 * Inscription data for commit transaction
 */
export interface InscriptionData {
  content: Uint8Array;
  contentType: string;
  metadata?: Record<string, unknown>;
}

/**
 * P2TR address information from inscription preparation
 */
export interface P2TRAddressInfo {
  address: string;
  script: Uint8Array;
  internalKey: Uint8Array;
}

/**
 * Prepared inscription with all necessary data for commit transaction
 * This matches the legacy PreparedInscription interface
 */
export interface PreparedInscription {
  commitAddress: P2TRAddressInfo;
  inscription: {
    tags: ordinals.Tags;
    body: Uint8Array;
  };
  revealPublicKey: Uint8Array;
  revealPrivateKey?: Uint8Array;
  inscriptionScript: {
    script: Uint8Array;
    controlBlock: Uint8Array;
    leafVersion: number;
  };
}

/**
 * Parameters for preparing a commit transaction
 * Matches legacy interface
 */
export interface CommitTransactionParams {
  /** The prepared inscription containing the commit address */
  inscription: PreparedInscription;
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
  /** CRITICAL: The specific UTXO selected by the user for inscription (must be first input) */
  selectedInscriptionUtxo?: Utxo;
}

/**
 * Result of the commit transaction preparation
 * Matches legacy interface
 */
export interface CommitTransactionResult {
  /** P2TR address for the commit output */
  commitAddress: string;
  /** Base64-encoded PSBT for the commit transaction */
  commitPsbtBase64: string;
  /** Raw PSBT object for commit transaction (for direct manipulation) */
  commitPsbt: btc.Transaction;
  /** The exact amount required for the commit output */
  requiredCommitAmount: number;
  /** Selected UTXOs for the transaction */
  selectedUtxos: Utxo[];
  /** Fee information */
  fees: {
    /** Estimated fee for the commit transaction in satoshis */
    commit: number;
  };
}

/**
 * Prepares an inscription by generating all necessary components using micro-ordinals
 * This is a helper to create PreparedInscription from InscriptionData
 */
export function prepareInscription(
  inscriptionData: InscriptionData,
  network: BitcoinNetwork = 'mainnet'
): PreparedInscription {
  // Convert to micro-ordinals inscription format
  const tags: ordinals.Tags = {
    contentType: inscriptionData.contentType
  };
  
  if (inscriptionData.metadata) {
    tags.metadata = inscriptionData.metadata;
  }
  
  const inscription: ordinals.Inscription = {
    tags,
    body: inscriptionData.content
  };
  
  // Generate random key pair for reveal
  const privateKey = new Uint8Array(32);
  crypto.getRandomValues(privateKey);
  const fullPubKey = schnorr.getPublicKey(privateKey);
  const xOnlyPubKey = fullPubKey.length === 33 ? fullPubKey.slice(1) : fullPubKey;
  
  // Generate inscription script tree using micro-ordinals
  const scriptTree = ordinals.p2tr_ord_reveal(xOnlyPubKey, [inscription]);
  
  // Get network object
  const btcNetwork = getScureNetwork(network);
  
  // Create P2TR address using @scure/btc-signer with micro-ordinals output
  const p2tr = btc.p2tr(
    xOnlyPubKey,
    scriptTree,
    btcNetwork,
    false,
    [ordinals.OutOrdinalReveal]
  );
  
  if (!p2tr.address) {
    throw new Error('Failed to create P2TR address for commit transaction');
  }
  
  // Extract script information
  const script = p2tr.script || btc.OutScript.encode({ type: 'tr', pubkey: xOnlyPubKey });
  
  // Extract control block and script from taproot leaves (type as any to match legacy)
  const leaves: any = p2tr.leaves || [];
  const leaf = leaves[0];
  
  return {
    commitAddress: {
      address: p2tr.address,
      script,
      internalKey: xOnlyPubKey
    },
    inscription,
    revealPublicKey: xOnlyPubKey,
    revealPrivateKey: privateKey,
    inscriptionScript: {
      script: leaf?.script || new Uint8Array(),
      controlBlock: leaf?.controlBlock || new Uint8Array(),
      leafVersion: leaf?.version ?? 0xc0
    }
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
 * Prepares a commit transaction for an ordinals inscription
 * FAITHFULLY PORTED FROM LEGACY - DO NOT MODIFY APPROACH
 * 
 * @param params - Parameters for the commit transaction
 * @returns Complete information for the prepared commit transaction
 */
export async function createCommitTransaction(
  params: CommitTransactionParams
): Promise<CommitTransactionResult> {
  const { 
    inscription, 
    utxos, 
    changeAddress, 
    feeRate,
    network,
    minimumCommitAmount = MIN_DUST_LIMIT,
    selectedInscriptionUtxo
  } = params;
  
  // Validate inputs (from legacy)
  if (!utxos || utxos.length === 0) {
    throw new Error('No UTXOs provided to fund the transaction.');
  }
  
  if (!inscription || !inscription.commitAddress) {
    throw new Error('Invalid inscription: missing commit address information.');
  }
  
  if (!changeAddress) {
    throw new Error('Change address is required.');
  }
  
  if (feeRate <= 0) {
    throw new Error(`Invalid fee rate: ${feeRate}`);
  }
  
  // Get the commit address from the prepared inscription
  const commitAddress = inscription.commitAddress.address;
  
  // Calculate minimum amount needed for the commit output
  const commitOutputValue = Math.max(minimumCommitAmount, MIN_DUST_LIMIT);
  
  // Handle user-selected UTXO for inscription (CRITICAL from legacy)
  let selectedUtxos: Utxo[] = [];
  let totalInputValue = 0;
  
  if (selectedInscriptionUtxo) {
    // ALWAYS use the user-selected UTXO as the first input
    selectedUtxos.push(selectedInscriptionUtxo);
    totalInputValue = selectedInscriptionUtxo.value;
    console.log(`[COMMIT] Using user-selected UTXO as first input: ${selectedInscriptionUtxo.txid}:${selectedInscriptionUtxo.vout} (${selectedInscriptionUtxo.value} sats)`);
  }
  
  // Estimate commit transaction size for initial fee calculation
  const estimatedCommitVBytes = estimateCommitTxSize(1, 2);
  const estimatedCommitFee = Number(calculateFee(estimatedCommitVBytes, feeRate));
  const totalNeeded = commitOutputValue + estimatedCommitFee;
  
  // Check if we need additional UTXOs for funding
  if (totalInputValue < totalNeeded) {
    const additionalAmountNeeded = totalNeeded - totalInputValue;
    
    const availableForFunding = selectedInscriptionUtxo 
      ? utxos.filter(utxo => !(utxo.txid === selectedInscriptionUtxo.txid && utxo.vout === selectedInscriptionUtxo.vout))
      : utxos;
    
    if (availableForFunding.length === 0 && totalInputValue < totalNeeded) {
      throw new Error(`Insufficient funds. Selected UTXO has ${totalInputValue} sats but need ${totalNeeded} sats total. No additional UTXOs available.`);
    }
    
    try {
      const fundingResult = selectUtxos(availableForFunding, {
        targetAmount: additionalAmountNeeded,
        strategy: 'minimize_inputs'
      });
      
      selectedUtxos.push(...fundingResult.selectedUtxos);
      totalInputValue += fundingResult.totalInputValue;
      
      console.log(`[COMMIT] Added ${fundingResult.selectedUtxos.length} funding UTXOs for additional ${fundingResult.totalInputValue} sats`);
    } catch (error) {
      throw new Error(`Insufficient total funds. Selected UTXO: ${totalInputValue} sats, Additional needed: ${additionalAmountNeeded} sats. ${error instanceof Error ? error.message : 'Unknown funding error'}`);
    }
  } else {
    console.log(`[COMMIT] Selected UTXO has sufficient funds (${totalInputValue} >= ${totalNeeded})`);
  }
  
  // If no user-selected UTXO, fall back to automatic selection
  if (!selectedInscriptionUtxo) {
    console.log(`[COMMIT] No user-selected UTXO provided, using automatic selection`);
    
    const selectionResult = selectUtxos(utxos, {
      targetAmount: totalNeeded,
      strategy: 'minimize_inputs'
    });
    
    selectedUtxos = selectionResult.selectedUtxos;
    totalInputValue = selectionResult.totalInputValue;
  }
  
  if (!selectedUtxos || selectedUtxos.length === 0) {
    throw new Error('No UTXOs selected for the transaction.');
  }
  
  // Get the network configuration
  const scureNetwork = getScureNetwork(network);
  
  // Create transaction using @scure/btc-signer (LEGACY APPROACH)
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
  const actualCommitVBytes = estimateCommitTxSize(tx.inputsLength, 2);
  const recalculatedCommitFee = Number(calculateFee(actualCommitVBytes, feeRate));
  
  // Add the commit output using the provided address (LEGACY APPROACH)
  tx.addOutputAddress(
    commitAddress,
    BigInt(commitOutputValue),
    scureNetwork
  );
  
  // Calculate change amount
  const changeAmount = totalInputValue - commitOutputValue - recalculatedCommitFee;
  
  // Add change output if above dust limit
  if (changeAmount >= MIN_DUST_LIMIT) {
    tx.addOutputAddress(
      changeAddress,
      BigInt(changeAmount),
      scureNetwork
    );
  } else if (changeAmount > 0) {
    console.log(`Change amount ${changeAmount} is below dust limit, adding to fee.`);
  }
  
  // Final fee calculation (includes any dust amount added to fee)
  const finalFee = totalInputValue - commitOutputValue - 
    (changeAmount >= MIN_DUST_LIMIT ? changeAmount : 0);
  
  // Get the PSBT as base64 (LEGACY FORMAT)
  const txPsbt = tx.toPSBT();
  const commitPsbtBase64 = typeof txPsbt === 'string' ? txPsbt : Buffer.from(txPsbt).toString('base64');
  
  return {
    commitAddress,
    commitPsbtBase64,
    commitPsbt: tx,
    requiredCommitAmount: commitOutputValue,
    selectedUtxos,
    fees: {
      commit: finalFee
    }
  };
}
