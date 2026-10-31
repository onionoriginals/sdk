import { StorageAdapter, FeeOracleAdapter, OrdinalsProvider } from '../adapters/index.js';
import type { KeyStore } from './keys.js';
import type { TelemetryHooks } from '../utils/telemetry.js';
import type { LogLevel, LogOutput } from '../utils/Logger.js';
import type { EventLoggingConfig } from '../utils/EventLogger.js';
import type { WebVHNetworkName } from './network.js';
import type { DIDCacheConfig } from '../did/DIDCache.js';
import type { OperationLock } from '../utils/OperationLock.js';
import type { OriginalsSigner } from '../crypto/OriginalsSigner.js';

// Base types for the Originals protocol
/** The DID layer an Original is identified at: local did:vh, web did:webvh, or Bitcoin did:btco. */
export type LayerType = 'did:vh' | 'did:webvh' | 'did:btco';

export interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  bitcoinRpcUrl?: string;
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  /**
   * Key PERSISTENCE (plan 041). This is not a signing authority: it cannot
   * represent custody that never exports a key, so prefer `signer`. A
   * keyStore still backs local-key flows.
   */
  keyStore?: KeyStore;
  /**
   * Default byte signer (plan 039) for DID and credential operations: the
   * path for custody that never exports keys (Turnkey, KMS, HSM, passkeys).
   */
  signer?: OriginalsSigner;
  enableLogging?: boolean;
  // WebVH network selection (defaults to 'production' - production)
  webvhNetwork?: WebVHNetworkName;
  // Optional pluggable adapters
  storageAdapter?: StorageAdapter;
  // Optional DID cache configuration
  didCache?: DIDCacheConfig;
  feeOracle?: FeeOracleAdapter;
  ordinalsProvider?: OrdinalsProvider;
  // Shared keyed lock coordinating money-spending inscriptions across managers
  // (issue #303).
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
  /** Raw resource bytes. SDK input boundaries also accept UTF-8 strings. */
  content?: Uint8Array;
  contentType: string;
  hash: string;                    // Content hash (unique per version)
  size?: number;
  version?: number;                // Version number (default 1)
  previousVersionHash?: string;    // Link to previous version (by content hash)
  createdAt?: string;              // ISO timestamp of when this version was created
}

/** Creation input. Strings are UTF-8 encoded once; all returned resources contain bytes. */
export type AssetResourceInput = Omit<AssetResource, 'content'> & { content?: Uint8Array | string };

/**
 * Key-persistence interface.
 *
 * As a SIGNING authority, KeyStore is deprecated (plan 039): it requires the
 * private key to be exportable, which locks out Turnkey/KMS/HSM/passkey
 * custody. Prefer configuring an {@link OriginalsSigner} (`config.signer` or
 * per-call `{ signer }`) — or wrap a KeyStore entry via `signerFromKeyStore`.
 * KeyStore itself survives as the key-persistence interface.
 */
export type { KeyStore } from './keys.js';

/**
 * External signer interface for DID operations (compatible with didwebvh-ts)
 * This allows integration with external key management systems like Turnkey
 *
 * @deprecated Use {@link OriginalsSigner} (plan 039): the document-level
 * `sign()` here delegates canonicalization to the signer, which is the
 * layering mistake that produced never-verifying proofs. Adapt an existing
 * implementation with `signerFromExternalSigner`, or produce a didwebvh-
 * compatible signer from an OriginalsSigner with `toExternalSigner`.
 * Retained for standalone identity and credential integrations; Originals
 * entries are signed by the separate `OriginalsSigner` in `./originals`.
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

/**
 * Signer for the commit transaction funding inputs of a sat-selected
 * inscription (see `inscribeOnSat`). The reveal is self-signed by an
 * ephemeral key generated internally — only the commit needs the caller.
 */
export interface BitcoinSigner {
  /**
   * Signs AND FINALIZES the commit PSBT, returning a fully-signed, finalized,
   * broadcast-ready transaction **hex** (NOT a base64 PSBT). The name says
   * "AndFinalize" precisely because returning a still-unfinalized PSBT is a
   * runtime error: the SDK passes this return value straight to
   * `broadcastTransaction` and parses it locally to compute the commit txid
   * (a PSBT fails to parse → `COMMIT_TX_INVALID`), and production providers
   * reject anything that is not raw tx hex.
   */
  signAndFinalizeCommitPsbt(psbtBase64: string): Promise<string>;
}
