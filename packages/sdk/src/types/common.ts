import { StorageAdapter, FeeOracleAdapter, OrdinalsProvider } from '../adapters/index.js';
import { TelemetryHooks } from '../utils/telemetry.js';
import type { LogLevel, LogOutput } from '../utils/Logger.js';
import type { EventLoggingConfig } from '../utils/EventLogger.js';
import type { WebVHNetworkName } from './network.js';
import type { DIDCacheConfig } from '../did/DIDCache.js';
import type { OperationLock } from '../utils/OperationLock.js';

// Base types for the Originals protocol
export type LayerType = 'did:cel' | 'did:webvh' | 'did:btco';

/**
 * Which kind of did:btco authorship append a cost preview is for (#407 phase 4):
 * `'update'` sizes the new media (a resource-version inscription); `'rotate'`
 * sizes the event-only reinscription (the rotated DID document).
 */
export type AppendKind = 'update' | 'rotate';

/**
 * Non-mutating cost quote for the NEXT did:btco authorship append (#407 phase 4).
 * Same fee-rate source/cap as the real inscribe path, so it tracks reality; a
 * ballpark for cost-awareness/consent, not a billing figure.
 */
export interface AppendCostEstimate {
  /** Estimated total inscription cost (sats) = feeRate × vbytes. */
  satoshis: number;
  /** The (capped) fee rate used (sat/vB). */
  feeRate: number;
  /** Estimated commit+reveal virtual size (vB). */
  vbytes: number;
  /** Size of the media/content being inscribed (bytes). */
  contentBytes: number;
}

/**
 * Confirm-gate policy for a paid did:btco authorship append (#407 phase 4).
 * `'now'` (default) inscribes immediately (phase-3 behavior). A callback is
 * awaited with the {@link AppendCostEstimate} BEFORE any log mutation: `true`
 * proceeds and inscribes; `false` cleanly ABORTS the whole append (no event
 * appended, nothing inscribed — a byte-identical no-op that throws
 * `PROVENANCE_APPEND_DECLINED` and emits `cel:inscribe-declined`).
 */
export type InscribeConfirm =
  | 'now'
  | ((estimate: AppendCostEstimate) => boolean | Promise<boolean>);

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
  // Default confirm-gate policy for paid did:btco authorship appends (#407 phase
  // 4). Omitted/'now' = inscribe immediately (phase-3 behavior); a callback is
  // consulted before each btco append and can cleanly abort it. Overridable per
  // call (e.g. addResourceVersion's opts.inscribeConfirm).
  inscribeConfirm?: InscribeConfirm;
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


