import { StorageAdapter, FeeOracleAdapter, OrdinalsProvider } from '../adapters';
import { TelemetryHooks } from '../utils/telemetry';
import type { LogLevel, LogOutput } from '../utils/Logger';
import type { EventLoggingConfig } from '../utils/EventLogger';

// Base types for the Originals protocol
export type LayerType = 'did:peer' | 'did:webvh' | 'did:btco';

export interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  bitcoinRpcUrl?: string;
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  keyStore?: KeyStore;
  enableLogging?: boolean;
  // Optional pluggable adapters
  storageAdapter?: StorageAdapter;
  feeOracle?: FeeOracleAdapter;
  ordinalsProvider?: OrdinalsProvider;
  // Optional telemetry hooks
  telemetry?: TelemetryHooks;
  // Enhanced logging configuration
  logging?: {
    level?: LogLevel;
    outputs?: LogOutput[];
    includeTimestamps?: boolean;
    includeContext?: boolean;
    eventLogging?: EventLoggingConfig;
    sanitizeLogs?: boolean; // Remove sensitive data
  };
  // Metrics configuration
  metrics?: {
    enabled?: boolean;
    exportFormat?: 'json' | 'prometheus';
    collectCache?: boolean;
  };
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

/**
 * External signer interface for DID operations (compatible with didwebvh-ts)
 * This allows integration with external key management systems like Privy
 */
export interface ExternalSigner {
  /**
   * Sign data and return a proof value
   * @param input - The signing input containing document and proof
   * @returns The proof value (typically multibase-encoded signature)
   */
  sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }>;
  
  /**
   * Get the verification method ID for this signer
   * @returns The verification method ID (e.g., "did:key:z6Mk...")
   */
  getVerificationMethodId(): Promise<string> | string;
}

/**
 * External verifier interface for DID operations (compatible with didwebvh-ts)
 */
export interface ExternalVerifier {
  /**
   * Verify a signature
   * @param signature - The signature bytes
   * @param message - The message bytes that were signed
   * @param publicKey - The public key bytes
   * @returns True if the signature is valid
   */
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
}


