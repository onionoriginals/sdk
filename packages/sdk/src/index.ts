/* istanbul ignore file */
// Initialize noble crypto libraries first (must run before any crypto operations)
import './crypto/noble-init.js';

import { OriginalsSDK } from './core/OriginalsSDK.js';

// Main exports
export { OriginalsSDK } from './core/OriginalsSDK.js';
export type { 
  OriginalsSDKOptions,
  OriginalResult,
  CreateOriginalOptions,
  UpdateOriginalOptions,
  CreateDIDOriginalOptions,
  UpdateDIDOriginalOptions
} from './core/OriginalsSDK.js';
export { OriginalsAsset } from './lifecycle/OriginalsAsset.js';
export type { ProvenanceChain } from './lifecycle/OriginalsAsset.js';

// Type exports
export * from './types/index.js';

// Manager exports
export { DIDManager, type CreateWebVHOptions, type CreateWebVHResult } from './did/DIDManager.js';
export { KeyManager } from './did/KeyManager.js';
export { Ed25519Verifier } from './did/Ed25519Verifier.js';
export * as encoding from './utils/encoding.js';
export { 
  CredentialManager,
  type ResourceCreatedSubject,
  type ResourceUpdatedSubject,
  type MigrationSubject,
  type OwnershipSubject,
  type CredentialChainOptions,
  type SelectiveDisclosureOptions,
  type DerivedProofResult
} from './vc/CredentialManager.js';
export { 
  LifecycleManager,
  type CostEstimate,
  type MigrationValidation,
  type LifecycleProgress,
  type ProgressCallback,
  type LifecycleOperationOptions
} from './lifecycle/LifecycleManager.js';
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
export { BBSCryptosuiteUtils } from './vc/cryptosuites/bbs.js';
export { BbsSimple } from './vc/cryptosuites/bbsSimple.js';
export * from './storage/index.js';

// Resource management exports
export { ResourceManager } from './resources/index.js';
export type {
  Resource,
  ResourceOptions,
  ResourceUpdateOptions,
  ResourceVersionHistory,
  ResourceManagerConfig,
  ResourceValidationResult,
  ResourceType,
} from './resources/index.js';
export { MIME_TYPE_MAP, DEFAULT_RESOURCE_CONFIG } from './resources/index.js';

// Crypto exports
export { Signer, ES256KSigner, Ed25519Signer, ES256Signer, Bls12381G2Signer } from './crypto/Signer.js';
export { multikey } from './crypto/Multikey.js';
export type { MultikeyType } from './crypto/Multikey.js';

// Event system exports
export * from './events/index.js';

// Migration system exports
export { MigrationManager } from './migration/index.js';
export * from './migration/types.js';

// Batch operations exports
export {
  BatchOperationExecutor,
  BatchValidator,
  BatchError,
  type BatchResult,
  type BatchOperationOptions,
  type BatchInscriptionOptions,
  type BatchInscriptionResult,
  type ValidationResult as BatchValidationResult
} from './lifecycle/BatchOperations.js';

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

// Utility exports
export * from './utils/validation.js';
export * from './utils/satoshi-validation.js';
export * from './utils/serialization.js';
export * from './utils/retry.js';
export * from './utils/telemetry.js';
export { sha256Bytes } from './utils/hash.js';

// Adapter exports (for testing and custom integrations)
export { OrdMockProvider } from './adapters/providers/OrdMockProvider.js';
export { FeeOracleMock } from './adapters/FeeOracleMock.js';
export type { OrdinalsProvider, FeeOracleAdapter, StorageAdapter } from './adapters/types.js';

// Default export
export default OriginalsSDK;