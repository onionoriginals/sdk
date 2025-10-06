import { StorageAdapter, FeeOracleAdapter, OrdinalsProvider } from '../adapters';
import { TelemetryHooks } from '../utils/telemetry';

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
}

export interface AssetResource {
  id: string;                      // Logical resource ID (stable across versions)
  type: string;                    // 'image', 'text', 'code', 'data', etc.
  url?: string;
  content?: string;
  contentType: string;
  hash: string;                    // Content hash (unique per version)
  size?: number;
  version?: number;                // Version number (default 1)
  previousVersionHash?: string;    // Link to previous version (by content hash)
  createdAt?: string;              // ISO timestamp of when this version was created
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


