/**
 * Commit Transaction Processing for Ordinals
 * 
 * This module implements the commit transaction process for ordinals inscriptions.
 * Ported from legacy/ordinalsplus to SDK.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
import { 
  Utxo, 
  CommitTransactionParams, 
  CommitTransactionResult, 
  InscriptionData,
  P2TRAddressInfo,
  DUST_LIMIT_SATS 
} from '../../types/bitcoin';
import { calculateFee } from '../fee-calculation';
import { selectUtxos, estimateTransactionSize } from '../utxo-selection';

// Initialize ECC library for bitcoinjs-lib
bitcoin.initEccLib(ecc);

// Create ECPair factory
const ECPair = ECPairFactory(ecc);

// Define minimum dust limit (satoshis)
const MIN_DUST_LIMIT = DUST_LIMIT_SATS;

/**
 * Get bitcoinjs-lib network object from network string
 */
function getBitcoinNetwork(network: 'mainnet' | 'testnet' | 'regtest' | 'signet'): bitcoin.Network {
  switch (network) {
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'testnet':
      return bitcoin.networks.testnet;
    case 'regtest':
      return bitcoin.networks.regtest;
    case 'signet':
      // Signet uses testnet network parameters
      return bitcoin.networks.testnet;
    default:
      return bitcoin.networks.bitcoin;
  }
}

/**
 * Create an inscription reveal script following Ordinals protocol
 * 
 * @param xOnlyPubkey - The x-only public key (32 bytes)
 * @param inscriptionData - The inscription data
 * @returns The taproot script for the inscription
 */
function createInscriptionScript(
  xOnlyPubkey: Buffer, 
  inscriptionData: InscriptionData
): Buffer {
  // Build the inscription script following the ordinals protocol
  // Format: OP_FALSE OP_IF "ord" 0x01 <content-type> 0x00 <content> OP_ENDIF
  const script = bitcoin.script.compile([
    xOnlyPubkey,
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_FALSE,
    bitcoin.opcodes.OP_IF,
    Buffer.from('ord', 'utf8'), // Ordinals protocol marker
    Buffer.from([0x01]), // Content type tag
    Buffer.from(inscriptionData.contentType, 'utf8'),
    Buffer.from([0x00]), // Content tag
    inscriptionData.content,
    bitcoin.opcodes.OP_ENDIF
  ]);
  
  return script;
}

/**
 * Generate a P2TR address for the commit transaction
 * 
 * @param inscriptionData - The inscription data
 * @param network - Bitcoin network
 * @returns P2TR address information including internal key and address
 */
function generateRevealAddress(
  inscriptionData: InscriptionData,
  network: bitcoin.Network
): P2TRAddressInfo {
  // Generate a random key pair for the reveal transaction
  const revealKeyPair = ECPair.makeRandom({ network });
  const internalKey = Buffer.from(revealKeyPair.publicKey.slice(1, 33)); // x-only pubkey (remove prefix byte)
  
  // Create the inscription script
  const inscriptionScript = createInscriptionScript(internalKey, inscriptionData);
  
  // Create a taproot tree with the inscription script
  const scriptTree = {
    output: inscriptionScript
  };
  
  // Create P2TR output with the script tree
  const { address, output } = bitcoin.payments.p2tr({
    internalPubkey: internalKey,
    scriptTree,
    network
  });
  
  if (!address) {
    throw new Error('Failed to generate P2TR address');
  }
  
  // For the tweaked key, we need to compute it from the internal key and script tree
  // This is a simplified version - in production, you'd need proper taproot tweaking
  const tweakedKey = internalKey; // Simplified - actual implementation would compute tweak
  
  return {
    address,
    internalKey,
    tweakedKey,
    scriptTree
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
 * @param params - Parameters for the commit transaction
 * @returns Complete information for the prepared commit transaction
 */
export async function createCommitTransaction(
  params: CommitTransactionParams
): Promise<CommitTransactionResult> {
  const { 
    utxos, 
    changeAddress, 
    feeRate,
    network,
    inscriptionData,
    minimumCommitAmount = MIN_DUST_LIMIT,
    selectedInscriptionUtxo
  } = params;
  
  // Validate inputs
  if (!utxos || utxos.length === 0) {
    throw new Error('No UTXOs provided to fund the transaction.');
  }
  
  if (!inscriptionData || !inscriptionData.content) {
    throw new Error('Invalid inscription data: missing content.');
  }
  
  if (!changeAddress) {
    throw new Error('Change address is required.');
  }
  
  if (feeRate <= 0) {
    throw new Error(`Invalid fee rate: ${feeRate}`);
  }
  
  // Get Bitcoin network
  const btcNetwork = getBitcoinNetwork(network);
  
  // Generate the reveal address (P2TR address for the inscription)
  const revealAddressInfo = generateRevealAddress(inscriptionData, btcNetwork);
  
  // Calculate minimum amount needed for the commit output
  const commitOutputValue = Math.max(minimumCommitAmount, MIN_DUST_LIMIT);
  
  // Handle user-selected UTXO for inscription
  let selectedUtxos: Utxo[] = [];
  let totalInputValue = 0;
  
  if (selectedInscriptionUtxo) {
    // ALWAYS use the user-selected UTXO as the first input
    selectedUtxos.push(selectedInscriptionUtxo);
    totalInputValue = selectedInscriptionUtxo.value;
    console.log(`[COMMIT] Using user-selected UTXO as first input: ${selectedInscriptionUtxo.txid}:${selectedInscriptionUtxo.vout} (${selectedInscriptionUtxo.value} sats)`);
  }
  
  // Estimate commit transaction size for initial fee calculation
  const estimatedCommitVBytes = estimateCommitTxSize(1, 2); // 1 input, 2 outputs (commit + change)
  
  // Calculate estimated fee
  const estimatedCommitFee = Number(calculateFee(estimatedCommitVBytes, feeRate));
  
  // Calculate total amount needed
  const totalNeeded = commitOutputValue + estimatedCommitFee;
  
  // Check if we need additional UTXOs for funding
  if (totalInputValue < totalNeeded) {
    const additionalAmountNeeded = totalNeeded - totalInputValue;
    
    // Filter out the already selected UTXO from available options
    const availableForFunding = selectedInscriptionUtxo 
      ? utxos.filter(utxo => !(utxo.txid === selectedInscriptionUtxo.txid && utxo.vout === selectedInscriptionUtxo.vout))
      : utxos;
    
    if (availableForFunding.length === 0 && totalInputValue < totalNeeded) {
      throw new Error(`Insufficient funds. Selected UTXO has ${totalInputValue} sats but need ${totalNeeded} sats total. No additional UTXOs available.`);
    }
    
    // Select additional UTXOs to cover the remaining amount
    try {
      const fundingResult = selectUtxos(availableForFunding, {
        targetAmount: additionalAmountNeeded,
        strategy: 'minimize_inputs'
      });
      
      // Add the funding UTXOs AFTER the selected inscription UTXO
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
  
  // Create the PSBT
  const psbt = new bitcoin.Psbt({ network: btcNetwork });
  
  // Add inputs
  for (const utxo of selectedUtxos) {
    if (!utxo.scriptPubKey) {
      console.warn(`Skipping UTXO ${utxo.txid}:${utxo.vout} due to missing scriptPubKey.`);
      continue;
    }
    
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: Buffer.from(utxo.scriptPubKey, 'hex'),
        value: utxo.value
      }
    });
  }
  
  // More accurate fee calculation now that we know exact input count
  const actualCommitVBytes = estimateCommitTxSize(psbt.data.inputs.length, 2); // 2 outputs (commit + change)
  const recalculatedCommitFee = Number(calculateFee(actualCommitVBytes, feeRate));
  
  // Add the commit output (P2TR address)
  psbt.addOutput({
    address: revealAddressInfo.address,
    value: commitOutputValue
  });
  
  // Calculate change amount
  const changeAmount = totalInputValue - commitOutputValue - recalculatedCommitFee;
  
  // Add change output if above dust limit
  if (changeAmount >= MIN_DUST_LIMIT) {
    psbt.addOutput({
      address: changeAddress,
      value: changeAmount
    });
  } else if (changeAmount > 0) {
    // If change is below dust limit, add it to the fee
    console.log(`Change amount ${changeAmount} is below dust limit, adding to fee.`);
  }
  
  // Final fee calculation (includes any dust amount added to fee)
  const finalFee = totalInputValue - commitOutputValue - 
    (changeAmount >= MIN_DUST_LIMIT ? changeAmount : 0);
  
  // Get the PSBT as base64
  const psbtBase64 = psbt.toBase64();
  
  return {
    psbt: psbtBase64,
    revealAddress: revealAddressInfo.address,
    revealAddressInfo,
    fee: finalFee,
    changeAmount: changeAmount >= MIN_DUST_LIMIT ? changeAmount : 0,
    selectedUtxos,
    commitAmount: commitOutputValue
  };
}
