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

/**
 * Data for an inscription to be committed
 */
export interface InscriptionData {
  /** The content to inscribe (as Buffer) */
  content: Buffer;
  /** MIME type of the content (e.g., 'text/plain', 'image/png') */
  contentType: string;
  /** Optional metadata for the inscription */
  metadata?: Record<string, unknown>;
}

/**
 * P2TR (Pay-to-Taproot) address information
 */
export interface P2TRAddressInfo {
  /** The P2TR address string */
  address: string;
  /** The internal key (x-only pubkey) */
  internalKey: Buffer;
  /** The tweaked key used for the P2TR output */
  tweakedKey: Buffer;
  /** Optional taproot script tree */
  scriptTree?: unknown;
}

/**
 * Parameters for creating a commit transaction
 */
export interface CommitTransactionParams {
  /** Available UTXOs to fund the transaction */
  utxos: Utxo[];
  /** Fee rate in satoshis per vbyte */
  feeRate: number;
  /** Inscription data to commit */
  inscriptionData: InscriptionData;
  /** Address to send change back to */
  changeAddress: string;
  /** Bitcoin network */
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  /** Optional minimum amount for the commit output (defaults to dust limit) */
  minimumCommitAmount?: number;
  /** Optional: specific UTXO to use as first input */
  selectedInscriptionUtxo?: Utxo;
}

/**
 * Result of creating a commit transaction
 */
export interface CommitTransactionResult {
  /** Base64-encoded PSBT for the commit transaction */
  psbt: string;
  /** P2TR address that will receive the commit output (for reveal transaction) */
  revealAddress: string;
  /** P2TR address information for the reveal */
  revealAddressInfo: P2TRAddressInfo;
  /** Total fee for the commit transaction in satoshis */
  fee: number;
  /** Change amount sent back (0 if below dust or no change) */
  changeAmount: number;
  /** Selected UTXOs used in the transaction */
  selectedUtxos: Utxo[];
  /** The amount committed to the reveal address */
  commitAmount: number;
}

/**
 * Detailed fee breakdown for commit transaction
 */
export interface CommitTransactionFee {
  /** Commit transaction fee */
  commit: number;
  /** Estimated reveal transaction fee */
  estimatedReveal?: number;
  /** Total estimated cost */
  total: number;
}


