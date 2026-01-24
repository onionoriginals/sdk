/**
 * BitcoinWitness - Bitcoin-based witness service for CEL event logs
 * 
 * Implements the WitnessService interface using Bitcoin ordinals inscriptions.
 * Used for the did:btco layer to anchor events on the Bitcoin blockchain,
 * providing the highest level of immutability and timestamping.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { WitnessProof } from '../types';
import type { WitnessService } from './WitnessService';
import type { BitcoinManager } from '../../bitcoin/BitcoinManager';

/**
 * Configuration options for BitcoinWitness
 */
export interface BitcoinWitnessOptions {
  /** Fee rate in sat/vB for inscription transactions (optional - BitcoinManager will estimate if not provided) */
  feeRate?: number;
  /** Verification method DID URL for the witness proof */
  verificationMethod?: string;
}

/**
 * Error thrown when the Bitcoin witness service fails
 */
export class BitcoinWitnessError extends Error {
  /** The digest that failed to be witnessed */
  readonly digest?: string;
  /** The underlying error message if available */
  readonly cause?: Error;
  
  constructor(message: string, digest?: string, cause?: Error) {
    super(message);
    this.name = 'BitcoinWitnessError';
    this.digest = digest;
    this.cause = cause;
  }
}

/**
 * Bitcoin inscription witness proof with additional Bitcoin-specific fields
 */
export interface BitcoinWitnessProof extends WitnessProof {
  /** The Bitcoin transaction ID containing the witness inscription */
  txid: string;
  /** The block height where the inscription was confirmed (if available) */
  blockHeight?: number;
  /** The satoshi ordinal number anchoring the inscription */
  satoshi: string;
  /** The inscription ID in the format {txid}i{index} */
  inscriptionId: string;
}

/**
 * Bitcoin-based witness service implementation
 * 
 * Inscribes digestMultibase on Bitcoin via ordinals and returns a WitnessProof
 * containing the transaction details and satoshi ordinal as anchor.
 * 
 * @example
 * ```typescript
 * const bitcoinManager = new BitcoinManager(config);
 * const witness = new BitcoinWitness(bitcoinManager);
 * const proof = await witness.witness('uEiD...');
 * console.log(proof.txid); // Bitcoin transaction ID
 * console.log(proof.satoshi); // Satoshi ordinal anchor
 * ```
 */
export class BitcoinWitness implements WitnessService {
  private readonly bitcoinManager: BitcoinManager;
  private readonly feeRate?: number;
  private readonly verificationMethod: string;
  
  /**
   * Creates a new BitcoinWitness instance
   * 
   * @param bitcoinManager - BitcoinManager instance configured with an ordinals provider
   * @param options - Optional configuration options
   */
  constructor(bitcoinManager: BitcoinManager, options: BitcoinWitnessOptions = {}) {
    if (!bitcoinManager) {
      throw new Error('BitcoinManager instance is required');
    }
    
    this.bitcoinManager = bitcoinManager;
    this.feeRate = options.feeRate;
    this.verificationMethod = options.verificationMethod ?? 'did:btco:witness';
  }
  
  /**
   * Witnesses a digest by inscribing it on the Bitcoin blockchain
   * 
   * @param digestMultibase - The Multibase-encoded digest to witness
   * @returns A BitcoinWitnessProof containing the inscription details and witnessedAt timestamp
   * @throws BitcoinWitnessError if the inscription fails
   */
  async witness(digestMultibase: string): Promise<BitcoinWitnessProof> {
    if (!digestMultibase || typeof digestMultibase !== 'string') {
      throw new BitcoinWitnessError('digestMultibase must be a non-empty string', digestMultibase);
    }
    
    // Validate multibase prefix (should start with 'u' for base64url-nopad or 'z' for base58btc)
    const validPrefixes = ['u', 'z'];
    if (!validPrefixes.includes(digestMultibase[0])) {
      throw new BitcoinWitnessError(
        `Invalid digestMultibase encoding: expected prefix 'u' or 'z', got '${digestMultibase[0]}'`,
        digestMultibase
      );
    }
    
    try {
      // Create witness attestation data
      const witnessData = {
        '@context': 'https://w3id.org/cel/v1',
        type: 'BitcoinWitnessAttestation',
        digestMultibase,
        witnessedAt: new Date().toISOString(),
      };
      
      // Inscribe the witness data on Bitcoin
      const inscription = await this.bitcoinManager.inscribeData(
        witnessData,
        'application/json',
        this.feeRate
      );
      
      // Validate inscription result
      if (!inscription.inscriptionId) {
        throw new BitcoinWitnessError(
          'Bitcoin inscription did not return a valid inscription ID',
          digestMultibase
        );
      }
      
      if (!inscription.txid) {
        throw new BitcoinWitnessError(
          'Bitcoin inscription did not return a transaction ID',
          digestMultibase
        );
      }
      
      const now = new Date().toISOString();
      
      // Build the WitnessProof with Bitcoin-specific extensions
      const proof: BitcoinWitnessProof = {
        type: 'DataIntegrityProof',
        cryptosuite: 'bitcoin-ordinals-2024',
        created: now,
        verificationMethod: this.verificationMethod,
        proofPurpose: 'assertionMethod',
        proofValue: `z${inscription.inscriptionId}`, // Use inscription ID as proof value with multibase prefix
        witnessedAt: now,
        txid: inscription.txid,
        blockHeight: inscription.blockHeight,
        satoshi: inscription.satoshi,
        inscriptionId: inscription.inscriptionId,
      };
      
      return proof;
      
    } catch (error) {
      // Re-throw BitcoinWitnessError as-is
      if (error instanceof BitcoinWitnessError) {
        throw error;
      }
      
      // Wrap other errors
      throw new BitcoinWitnessError(
        `Failed to inscribe witness on Bitcoin: ${error instanceof Error ? error.message : String(error)}`,
        digestMultibase,
        error instanceof Error ? error : undefined
      );
    }
  }
  
  /**
   * Gets the fee rate configured for this witness (if any)
   */
  get configuredFeeRate(): number | undefined {
    return this.feeRate;
  }
}
