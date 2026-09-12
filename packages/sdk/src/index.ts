/* istanbul ignore file */
// No side-effect imports here: noble sync-hash config happens at point of use
// (crypto/Signer.ts, did/KeyManager.ts), so `sideEffects: false` holds.

import { OriginalsSDK } from './core/OriginalsSDK3.js';

// Main exports
export { OriginalsSDK } from './core/OriginalsSDK3.js';
export type { 
  OriginalResult,
  CreateOriginalOptions,
  UpdateOriginalOptions,
  CreateDIDOriginalOptions,
  UpdateDIDOriginalOptions
} from './did/identity-operations.js';
export { OriginalsAsset } from './v3/OriginalsAsset.js';
export { ASSET_ENVELOPE_FORMAT, ASSET_ENVELOPE_VERSION, ASSET_LIMITS } from './v3/envelope.js';
export type { AssetEnvelope, AssetResource, AssetResourceInput, AssetUpdate, AssetVerification, MutationOptions, MutationResult, LoadedAsset, LoadAssetOptions, LocalResource } from './v3/types.js';

// Type exports
export type { LayerType, AppendFailurePolicy, KeyStore, ExternalSigner, ExternalVerifier, BitcoinSigner } from './types/common.js';
export * from './types/did.js';
export * from './types/credentials.js';
export * from './types/bitcoin.js';
export * from './types/network.js';
export * from './types/multisig.js';

// Manager exports
export { DIDManager, type CreateWebVHOptions, type CreateWebVHResult } from './did/DIDManager.js';
export { computeNextKeyHash, normalizeUpdateKey } from './did/WebVHManager.js';
export { DIDCache, type DIDCacheConfig, type DIDCacheStorage, type DIDCacheEntry } from './did/DIDCache.js';
export { KeyManager } from './did/KeyManager.js';
export { Ed25519Verifier } from './did/Ed25519Verifier.js';
export * as encoding from '@originals/cel/encoding';
export { 
  CredentialManager,
  type ResourceCreatedSubject,
  type ResourceUpdatedSubject,
  type MigrationSubject,
  type OwnershipSubject,
  type CredentialChainOptions
} from './vc/CredentialManager.js';
export {
  StatusListManager,
  type StatusListOptions,
  type StatusCheckResult,
} from './vc/StatusListManager.js';
export { BitstringStatusList } from './vc/BitstringStatusList.js';
export { LifecycleManager } from './v3/OriginalsSDK.js';
export type { CreateAssetOptions } from './v3/types.js';
export type { OriginalsSDKOptions, OriginalsConfig } from './core/OriginalsSDK3.js';
export { createLocalSigner, type CelSigner } from '@originals/cel/v3';
export { BitcoinManager } from './bitcoin/BitcoinManager.js';
export { OrdinalsClient } from './bitcoin/OrdinalsClient.js';
export { buildTransferTransaction } from './bitcoin/transfer.js';
export { selectUtxos, UtxoSelectionError, estimateFeeSats } from './bitcoin/utxo.js';
export { 
  selectUtxos as selectUtxosSimple,
  selectResourceUtxos,
  selectUtxosForPayment,
  tagResourceUtxos,
  estimateTransactionSize
} from './bitcoin/utxo-selection.js';
export { calculateFee } from './bitcoin/fee-calculation.js';
// Remote-signer verification toolkit (plan 043): the verifier, the EdDSA suite
// (shared signing-input construction), and the JSON-LD document loader.
export { Verifier } from './vc/Verifier.js';
export type { StatusListResolver } from './vc/Verifier.js';
export { EdDSACryptosuiteManager } from './vc/cryptosuites/eddsa.js';
export { createDocumentLoader } from './vc/documentLoader.js';
export { MultiSigManager } from './vc/MultiSigManager.js';
export * from './storage/index.js';

// Resource management exports
export { ResourceManager } from './resources/index.js';
export type {
  Resource,
  ResourceSnapshot,
  ResourceOptions,
  ResourceUpdateOptions,
  ResourceVersionHistory,
  ResourceVersion,
  ResourceManagerConfig,
  ResourceValidationResult,
  ResourceType,
} from './resources/index.js';
export { MIME_TYPE_MAP, DEFAULT_RESOURCE_CONFIG } from './resources/index.js';

// Crypto exports
export { Signer, ES256KSigner, Ed25519Signer, ES256Signer, Bls12381G2Signer } from './crypto/Signer.js';
export { multikey } from '@originals/cel';
export type { MultikeyType } from '@originals/cel';

// Signer abstraction (plan 039): one root interface, one signing-input
// namespace, adapters in both directions, and the conformance harness (040).
export type { OriginalsSigner } from './crypto/OriginalsSigner.js';
export {
  canonicalDidKeyVm,
  signerFromKeyPair,
  signerFromKeyStore,
  signerFromExternalSigner,
  toExternalSigner,
} from './crypto/OriginalsSigner.js';
export { signingInput, type SigningDocumentLoader } from './crypto/signingInput.js';
export { assertSignerConformance } from './crypto/signerConformance.js';
export { MockRemoteSigner } from './crypto/MockRemoteSigner.js';
// Custody backends hand back addresses, not Multikeys (plan 045).
export { base58AddressToEd25519Multikey } from './crypto/addressToMultikey.js';

// Independent typed event utility. The CEL 3 lifecycle returns explicit results
// and does not emit the preceding implementation's asset lifecycle payloads.
export { EventEmitter } from './events/EventEmitter.js';

// Migration system (EXPERIMENTAL — intentionally NOT part of the public API).
//
// The `MigrationManager` subsystem (validation pipeline, checkpoints, rollback,
// audit log, state machine) is experimental and is NOT the migration path used
// in production: `OriginalsSDK`/`LifecycleManager` run their own
// migrate/publish/inscribe flow and never instantiate `MigrationManager`
// (issue #279). Re-exporting it from the package entry point advertised unused
// machinery as a supported API, so it is deliberately not exported here. It
// remains importable from its module path for experimentation, at the caller's
// own risk. Only the `MigrationError` type remains for consumers of the independent
// typed EventEmitter utility; this does not export the migration engine.
export type { MigrationError } from './migration/types.js';

// Kind system exports
export {
  OriginalKind,
  KindRegistry,
  type DependencyRef,
  type BaseManifest,
  type AppMetadata,
  type AgentMetadata,
  type ModuleMetadata,
  type DatasetMetadata,
  type MediaMetadata,
  type DocumentMetadata,
  type KindMetadataMap,
  type KindMetadata,
  type OriginalManifest,
  type AppManifest,
  type AgentManifest,
  type ModuleManifest,
  type DatasetManifest,
  type MediaManifest,
  type DocumentManifest,
  type AnyManifest,
  type ValidationResult as KindValidationResult,
  type ValidationError as KindValidationError,
  type ValidationWarning,
  type CreateTypedOriginalOptions,
  type KindValidator,
  BaseKindValidator,
  ValidationUtils,
  AppValidator,
  AgentValidator,
  ModuleValidator,
  DatasetValidator,
  MediaValidator,
  DocumentValidator,
} from './kinds/index.js';

// Observability exports
export {
  MetricsCollector,
  type OperationMetrics,
  type Metrics,
} from './utils/MetricsCollector.js';
export { Logger } from './utils/Logger.js';
export type { LogLevel, LogOutput } from './utils/Logger.js';
export { EventLogger } from './utils/EventLogger.js';
export type { EventLoggingConfig } from './utils/EventLogger.js';
export { OperationLock } from './utils/OperationLock.js';

// Utility exports. retry/circuit-breaker are internal infrastructure, not API
// (plan 043); they remain importable in-repo but are no longer re-exported.
// satoshi-validation / telemetry / sha256Bytes moved to @originals/cel — named
// re-exports (not `export *`) so the SDK surface stays exactly what it was.
export * from './utils/validation.js';
export * from './utils/bitcoin-address.js';
export {
  MAX_SATOSHI_SUPPLY,
  validateSatoshiNumber,
  canonicalizeSatoshi,
  parseSatoshiIdentifier,
  assertValidSatoshi,
} from '@originals/cel';
export type { SatoshiValidationResult } from '@originals/cel';
export * from './utils/serialization.js';
export { StructuredError, emitTelemetry, emitError } from '@originals/cel';
export type { TelemetryLevel, TelemetryEvent, TelemetryHooks } from '@originals/cel';
export { sha256Bytes } from '@originals/cel';

// Adapter exports (custom integrations). Test doubles (OrdMockProvider,
// FeeOracleMock) moved to '@originals/sdk/testing' (plan 043).
export { SignetProvider } from './bitcoin/providers/SignetProvider.js';
export type { SignetProviderOptions } from './bitcoin/providers/SignetProvider.js';
export { QuickNodeProvider } from './adapters/providers/QuickNodeProvider.js';
export type { QuickNodeProviderOptions } from './adapters/providers/QuickNodeProvider.js';
export { RegtestProvider } from './adapters/providers/RegtestProvider.js';
export type { RegtestProviderOptions, RegtestOutput } from './adapters/providers/RegtestProvider.js';
export type { OrdinalsProvider, FeeOracleAdapter, StorageAdapter } from './adapters/types.js';

// One public CEL 3 parser, proof verifier and state fold.
export { verifyHistory, checkpointFromHistory, parseDocument, encodeDocument, validateDocument, eventDigest, signEvent, verifyEntry, createNonce, digestBytes, CelError, CEL_LIMITS } from '@originals/cel/v3';
export type { CelDocument, CelEntry, CelEvent, Operation, ControllerProof, VerifiedHistory, HistoryCheckpoint, AssetState, Algorithm, Cryptosuite } from '@originals/cel/v3';

// Default export
export default OriginalsSDK;
/** Minimal local-only entry using the same CEL 3 lifecycle as the default SDK. */
export * as v3 from './v3/index.js';

export type { SatProvider, AssetResolution, AssetResolutionOptions, AssetDIDResolution } from "./v3/resolution.js";

export type { WebPublicationOptions, PreparedWebPublication, PublishedWebAsset, HostedEvidence } from "./v3/hosted.js";

export type { BitcoinPublicationOptions, PreparedBitcoinPublication, BitcoinSubmissionOptions, SubmittedBitcoinAsset } from "./v3/bitcoin.js";

export { prepareInscriptionOnSat, submitPreparedInscriptionOnSat, resumeInscriptionOnSat } from './bitcoin/inscribe-on-sat.js';
export { validateInscriptionReveal } from './bitcoin/inscription-recovery.js';
export type { InscribeOnSatResult, PreparedInscriptionOnSat, InscriptionRecoveryStore, InscriptionRecoveryRecord, InscriptionBroadcastState } from './bitcoin/inscribe-on-sat.js';

export { readEnvelope as parseAssetEnvelope, inspectAssetEnvelope, type AssetEnvelopeInspection } from "./v3/envelope.js";
