import { StorageAdapter, FeeOracleAdapter, OrdinalsProvider } from '../adapters';
import { TelemetryHooks } from '../utils/telemetry';

// Base types for the Originals protocol
export type LayerType = 'did:peer' | 'did:webvh' | 'did:btco';

export interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  bitcoinRpcUrl?: string;
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  enableLogging?: boolean;
  // Optional pluggable adapters
  storageAdapter?: StorageAdapter;
  feeOracle?: FeeOracleAdapter;
  ordinalsProvider?: OrdinalsProvider;
  // Optional telemetry hooks
  telemetry?: TelemetryHooks;
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

export interface KeyStore {
  getPrivateKey(verificationMethodId: string): Promise<string | null>;
  setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void>;
}


