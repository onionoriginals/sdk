// Base types for the Originals protocol
export type LayerType = 'did:peer' | 'did:webvh' | 'did:btco';

export interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest';
  bitcoinRpcUrl?: string;
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  enableLogging?: boolean;
}

export interface AssetResource {
  id: string;
  type: string; // 'image', 'text', 'code', 'data', etc.
  url?: string;
  content?: string;
  contentType: string;
  hash: string; // SHA-256 hash for integrity
  size?: number;
}


