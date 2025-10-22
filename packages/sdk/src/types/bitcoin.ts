// Bitcoin/Ordinals types
export interface OrdinalsInscription {
  satoshi: string; // Unique satoshi identifier
  inscriptionId: string;
  content: Buffer;
  contentType: string;
  txid: string;
  vout: number;
  blockHeight?: number;
}

export interface BitcoinTransaction {
  txid: string;
  vin: TransactionInput[];
  vout: TransactionOutput[];
  fee: number;
  blockHeight?: number;
  confirmations?: number;
}

export interface TransactionInput {
  txid: string;
  vout: number;
  scriptSig?: string;
  witness?: string[];
}

export interface TransactionOutput {
  value: number; // satoshis
  scriptPubKey: string;
  address?: string;
}

export interface Utxo {
  txid: string;
  vout: number;
  value: number; // satoshis
  scriptPubKey?: string;
  address?: string;
  inscriptions?: string[]; // inscription ids located on this outpoint
  locked?: boolean; // if true, cannot be spent due to wallet locks
}

/**
 * Extended UTXO interface that tracks whether it contains an Ordinals resource (inscription)
 */
export interface ResourceUtxo extends Utxo {
  /** True if this UTXO contains an inscription or other Ordinals resource */
  hasResource?: boolean;
}

/**
 * Strategy for selecting UTXOs
 */
export type UtxoSelectionStrategy = 'minimize_change' | 'minimize_inputs' | 'optimize_size';

/**
 * Options for resource-aware UTXO selection
 */
export interface ResourceUtxoSelectionOptions {
  /** Required amount in satoshis */
  requiredAmount: number;
  /** Fee rate in satoshis per vbyte */
  feeRate: number;
  /** Allow using UTXOs that contain resources (default: false) */
  allowResourceUtxos?: boolean;
  /** Prefer older UTXOs (default: false) */
  preferOlder?: boolean;
  /** Prefer UTXOs with value closer to required amount (default: false) */
  preferCloserAmount?: boolean;
  /** List of UTXO IDs to avoid using (format: "txid:vout") */
  avoidUtxoIds?: string[];
}

/**
 * Result of resource-aware UTXO selection
 */
export interface ResourceUtxoSelectionResult {
  /** Selected UTXOs for the transaction */
  selectedUtxos: ResourceUtxo[];
  /** Total value of selected UTXOs */
  totalSelectedValue: number;
  /** Estimated transaction fee in satoshis */
  estimatedFee: number;
  /** Change amount in satoshis (0 if less than dust) */
  changeAmount: number;
}

export const DUST_LIMIT_SATS = 546;

export interface KeyPair {
  privateKey: string; // multibase encoded
  publicKey: string;  // multibase encoded
}

export type KeyType = 'ES256K' | 'Ed25519' | 'ES256';


