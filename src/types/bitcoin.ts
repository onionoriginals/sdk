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

export const DUST_LIMIT_SATS = 546;

export interface KeyPair {
  privateKey: string; // multibase encoded
  publicKey: string;  // multibase encoded
}

export type KeyType = 'ES256K' | 'Ed25519' | 'ES256';


