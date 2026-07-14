import { StorageAdapter, FeeOracleAdapter, OrdinalsProvider } from '../adapters/index.js';
import { TelemetryHooks } from '../utils/telemetry.js';
import type { LogLevel, LogOutput } from '../utils/Logger.js';
import type { EventLoggingConfig } from '../utils/EventLogger.js';
import type { WebVHNetworkName } from './network.js';
import type { DIDCacheConfig } from '../did/DIDCache.js';
import type { OperationLock } from '../utils/OperationLock.js';

// Base types for the Originals protocol
export type LayerType = 'did:peer' | 'did:cel' | 'did:webvh' | 'did:btco';

export interface OriginalsConfig {
  network: 'mainnet' | 'regtest' | 'signet';
  bitcoinRpcUrl?: string;
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  keyStore?: KeyStore;
  enableLogging?: boolean;
  // WebVH network selection (defaults to 'pichu' - production)
  webvhNetwork?: WebVHNetworkName;
  // Optional pluggable adapters
  storageAdapter?: StorageAdapter;
  // Optional DID cache configuration
  didCache?: DIDCacheConfig;
  feeOracle?: FeeOracleAdapter;
  ordinalsProvider?: OrdinalsProvider;
  // Shared keyed lock coordinating money-spending inscriptions across managers
  // (issue #303). OriginalsSDK injects one instance so all managers share it.
  operationLock?: OperationLock;
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
 * This allows integration with external key management systems like Turnkey
 */
export interface ExternalSigner {
  /**
   * Sign data and return a proof value
   * @param input - The signing input containing document and proof
   * @returns The proof value (typically multibase-encoded signature)
   */
  sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }>;

  /**
   * OPTIONAL: sign pre-canonicalized, pre-hashed bytes (issue #310).
   *
   * Required for multi-sig `eddsa-rdfc-2022` contributions
   * (`MultiSigManager.signWithExternalSigner`), where the SDK — not the signer
   * — canonicalizes and hashes with RDFC-2022, and the signer must sign
   * exactly those bytes. The document-level {@link ExternalSigner.sign} above
   * lets the signer choose its own canonicalization (didwebvh-ts signers use
   * JCS), which does NOT match multi-sig verification; a `sign()`-only signer's
   * multi-sig contribution can never verify. Signers that back multi-sig must
   * implement this and return the raw signature bytes.
   *
   * @param data - The exact bytes to sign (already canonicalized + hashed).
   * @returns The raw signature bytes.
   */
  signBytes?(data: Uint8Array): Promise<{ signature: Uint8Array }>;

  /**
   * Get the verification method ID for this signer
   * @returns The verification method ID (e.g., "did:key:z6Mk...")
   */
  getVerificationMethodId(): string;
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


