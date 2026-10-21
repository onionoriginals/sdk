/* istanbul ignore file */
// No side-effect imports here: noble sync-hash config happens at point of use
// (crypto/Signer.ts, did/KeyManager.ts), so `sideEffects: false` holds.

/**
 * `@originals/sdk`: the Originals Protocol SDK (plan 011). The root exports the
 * Originals workflow from `./originals/` (create, edit, load, verify, evidence
 * packages) together with the DID, credential, storage, Bitcoin and provider
 * utilities that it builds on. See ORIGINALS.md for the consumer contract.
 */

// The Originals workflow: OriginalsSDK, signers, stores, evidence packages.
export * from './originals/index.js';
export { OriginalsSDK as default } from './originals/sdk.js';

// did:webvh identity operations (author DIDs), as plain functions.
export {
  createOriginal,
  createDIDOriginal,
  updateOriginal,
  updateDIDOriginal,
  verifyDIDSignature,
  prepareDIDDataForSigning,
} from './did/identity-operations.js';
export type {
  OriginalResult,
  CreateOriginalOptions,
  UpdateOriginalOptions,
  CreateDIDOriginalOptions,
  UpdateDIDOriginalOptions,
  VerificationMethodInput,
} from './did/identity-operations.js';

// Type exports
export type { LayerType, KeyStore, ExternalSigner, ExternalVerifier, BitcoinSigner, OriginalsConfig, AssetResource, AssetResourceInput } from './types/common.js';
export * from './types/did.js';
export * from './types/credentials.js';
export * from './types/bitcoin.js';
export * from './types/network.js';
export * from './types/multisig.js';

// DID managers and helpers
export { DIDManager, type CreateWebVHOptions, type CreateWebVHResult } from './did/DIDManager.js';
export { computeNextKeyHash, normalizeUpdateKey } from './did/WebVHManager.js';
export { DIDCache, type DIDCacheConfig, type DIDCacheStorage, type DIDCacheEntry } from './did/DIDCache.js';
export { KeyManager } from './did/KeyManager.js';
export { Ed25519Verifier } from './did/Ed25519Verifier.js';

// Verifiable credentials
export {
  CredentialManager,
  type ResourceCreatedSubject,
  type ResourceUpdatedSubject,
  type MigrationSubject,
  type OwnershipSubject,
  type CredentialChainOptions,
} from './vc/CredentialManager.js';
export {
  StatusListManager,
  type StatusListOptions,
  type StatusCheckResult,
} from './vc/StatusListManager.js';
export { BitstringStatusList } from './vc/BitstringStatusList.js';
// Remote-signer verification toolkit (plan 043): the verifier, the EdDSA suite
// (shared signing-input construction), and the JSON-LD document loader.
export { Verifier } from './vc/Verifier.js';
export type { StatusListResolver } from './vc/Verifier.js';
export { EdDSACryptosuiteManager } from './vc/cryptosuites/eddsa.js';
export { createDocumentLoader } from './vc/documentLoader.js';
export { MultiSigManager } from './vc/MultiSigManager.js';

// Storage adapters
export * from './storage/index.js';

// Resource management
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

// Kind system
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

// Crypto: key signers, Multikey, and the byte-signer abstraction (plan 039).
// The byte signer is exported as `ByteSigner`: the root `OriginalsSigner` is
// the Originals entry signer from `./originals/`.
export { Signer, ES256KSigner, Ed25519Signer, ES256Signer, Bls12381G2Signer } from './crypto/Signer.js';
export { multikey } from './crypto/Multikey.js';
export type { MultikeyType } from './crypto/Multikey.js';
export type { OriginalsSigner as ByteSigner } from './crypto/OriginalsSigner.js';
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

// Encoding (namespaced: member names such as encode/decode would collide).
export * as encoding from './utils/encoding.js';

// Independent typed event utility.
export { EventEmitter } from './events/EventEmitter.js';

// Observability
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

// Utilities. retry/circuit-breaker are internal infrastructure, not API (plan 043).
export * from './utils/validation.js';
export * from './utils/bitcoin-address.js';
export {
  MAX_SATOSHI_SUPPLY,
  validateSatoshiNumber,
  canonicalizeSatoshi,
  parseSatoshiIdentifier,
  assertValidSatoshi,
} from './utils/satoshi-validation.js';
export type { SatoshiValidationResult } from './utils/satoshi-validation.js';
export * from './utils/serialization.js';
export { StructuredError, emitTelemetry, emitError } from './utils/telemetry.js';
export type { TelemetryLevel, TelemetryEvent, TelemetryHooks } from './utils/telemetry.js';
export { sha256Bytes } from './utils/hash.js';

// Bitcoin
export { BitcoinManager } from './bitcoin/BitcoinManager.js';
export { OrdinalsClient } from './bitcoin/OrdinalsClient.js';
export { buildTransferTransaction } from './bitcoin/transfer.js';
export { selectUtxos, UtxoSelectionError, estimateFeeSats } from './bitcoin/utxo.js';
export {
  selectUtxos as selectUtxosSimple,
  selectResourceUtxos,
  selectUtxosForPayment,
  tagResourceUtxos,
  estimateTransactionSize,
} from './bitcoin/utxo-selection.js';
export { calculateFee } from './bitcoin/fee-calculation.js';
export { prepareInscriptionOnSat, submitPreparedInscriptionOnSat, resumeInscriptionOnSat } from './bitcoin/inscribe-on-sat.js';
export { validateInscriptionReveal } from './bitcoin/inscription-recovery.js';
export type { InscribeOnSatResult, PreparedInscriptionOnSat, InscriptionRecoveryStore, InscriptionRecoveryRecord, InscriptionBroadcastState } from './bitcoin/inscribe-on-sat.js';
export {
  normalizeInscriptionId,
  normalizeSatpoint,
  normalizeTxid,
  digestBytes,
} from './bitcoin/sat-snapshot-types.js';
export type {
  SatSnapshot,
  BitcoinNetwork,
  ChainTip,
  CreationPosition,
  PublicationObservation,
  IndependentContentEvidence,
} from './bitcoin/sat-snapshot-types.js';
export { createBitcoinCoreChainValidator, type BitcoinCoreChainValidatorOptions, type ChainValidator } from './bitcoin/chain-validation.js';
export { createBitcoinCoreContentValidator, type BitcoinCoreContentValidatorOptions, type ContentValidator } from './bitcoin/content-validation.js';

// Providers (custom integrations). Test doubles (OrdMockProvider,
// FeeOracleMock) live in '@originals/sdk/testing' (plan 043).
export { SignetProvider } from './bitcoin/providers/SignetProvider.js';
export type { SignetProviderOptions } from './bitcoin/providers/SignetProvider.js';
export { QuickNodeProvider } from './adapters/providers/QuickNodeProvider.js';
export type { QuickNodeProviderOptions } from './adapters/providers/QuickNodeProvider.js';
export { RegtestProvider } from './adapters/providers/RegtestProvider.js';
export type { RegtestProviderOptions, RegtestOutput } from './adapters/providers/RegtestProvider.js';
export { OrdHttpProvider } from './adapters/providers/OrdHttpProvider.js';
export type { SatSnapshotReader, SatSnapshotBudget, SatSnapshotOptions } from './adapters/providers/sat-snapshot.js';
export type { OrdinalsProvider, FeeOracleAdapter, StorageAdapter } from './adapters/types.js';
