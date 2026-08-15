import { StorageAdapter, FeeOracleAdapter, OrdinalsProvider } from '../adapters/index.js';
import { TelemetryHooks } from '../utils/telemetry.js';
import type { LogLevel, LogOutput } from '../utils/Logger.js';
import type { EventLoggingConfig } from '../utils/EventLogger.js';
import type { WebVHNetworkName } from './network.js';
import type { DIDCacheConfig } from '../did/DIDCache.js';
import type { OperationLock } from '../utils/OperationLock.js';
import type { OriginalsSigner } from '../crypto/OriginalsSigner.js';

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
  /** The fee rate used (sat/vB), from the same resolver the real inscribe path
   * uses (feeOracle→provider, absurd >MAX_REASONABLE_FEE_RATE sources skipped; an
   * explicit override passes through). */
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
 *
 * The callback runs INSIDE the asset's append turn; it must not call another
 * mutating op on the SAME asset (e.g. `addResourceVersion`/`rotateBtcoKeys`),
 * which would queue behind its own turn and deadlock. Inspect and decide only.
 */
export type InscribeConfirm =
  | 'now'
  | ((estimate: AppendCostEstimate) => boolean | Promise<boolean>);

/**
 * What a lifecycle operation does when it cannot sign its own provenance event
 * (plan 041). `'throw'` (default) fails the operation — it has not really
 * succeeded if the log is missing the event it just described. `'skip'` is the
 * pre-041 behavior: emit `cel:append-skipped` and carry on.
 */
export type AppendFailurePolicy = 'throw' | 'skip';

export interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  bitcoinRpcUrl?: string;
  defaultKeyType: 'ES256K' | 'Ed25519' | 'ES256';
  /**
   * Key PERSISTENCE (plan 041). This is not a signing authority: it cannot
   * represent custody that never exports a key, so prefer `signer` for
   * authorship. A keyStore still backs local-key flows and is probed for the
   * controller's key when no signer matches.
   */
  keyStore?: KeyStore;
  /**
   * Default authorship signer (plan 039). When set, lifecycle authorship ops
   * (createAsset, publishToWeb, inscribeOnBitcoin, rotateBtcoKeys,
   * addResourceVersion) sign CEL events with it instead of looking a private
   * key up in `keyStore` — the path for custody that never exports keys
   * (Turnkey, KMS, HSM, passkeys). Overridable per call via `{ signer }`.
   */
  signer?: OriginalsSigner;
  /** Default policy when a provenance append cannot be signed (default 'throw'). */
  onAppendFailure?: AppendFailurePolicy;
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
  // consulted before each gated paid btco append (addResourceVersion,
  // rotateBtcoKeys) and can cleanly abort it. Overridable per call (their
  // opts.inscribeConfirm).
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

/**
 * Key-persistence interface: stores and retrieves multibase-encoded private
 * keys by verification method id.
 *
 * As a SIGNING authority, KeyStore is deprecated (plan 039): it requires the
 * private key to be exportable, which locks out Turnkey/KMS/HSM/passkey
 * custody. Prefer configuring an {@link OriginalsSigner} (`config.signer` or
 * per-call `{ signer }`) — or wrap a KeyStore entry via `signerFromKeyStore`.
 * KeyStore itself survives as the key-persistence interface.
 */
export interface KeyStore {
  getPrivateKey(verificationMethodId: string): Promise<string | null>;
  setPrivateKey(verificationMethodId: string, privateKey: string): Promise<void>;
}

/**
 * External signer interface for DID operations (compatible with didwebvh-ts)
 * This allows integration with external key management systems like Turnkey
 *
 * @deprecated Use {@link OriginalsSigner} (plan 039): the document-level
 * `sign()` here delegates canonicalization to the signer, which is the
 * layering mistake that produced never-verifying proofs. Adapt an existing
 * implementation with `signerFromExternalSigner`, or produce a didwebvh-
 * compatible signer from an OriginalsSigner with `toExternalSigner`.
 * Removal is planned for 3.0 (plan 041).
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

