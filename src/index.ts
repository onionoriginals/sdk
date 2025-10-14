/* istanbul ignore file */
import { OriginalsSDK } from './core/OriginalsSDK.js';

// Main exports
export { OriginalsSDK } from './core/OriginalsSDK.js';
export type { OriginalsSDKOptions } from './core/OriginalsSDK.js';
export { OriginalsAsset } from './lifecycle/OriginalsAsset.js';
export type { ProvenanceChain } from './lifecycle/OriginalsAsset.js';

// Type exports
export * from './types/index.js';

// Manager exports
export { DIDManager, type CreateWebVHOptions, type CreateWebVHResult } from './did/DIDManager.js';
export { KeyManager } from './did/KeyManager.js';
export { CredentialManager } from './vc/CredentialManager.js';
export { LifecycleManager } from './lifecycle/LifecycleManager.js';
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

// Crypto exports
export { Signer, ES256KSigner, Ed25519Signer, ES256Signer, Bls12381G2Signer } from './crypto/Signer.js';
export { multikey } from './crypto/Multikey.js';
export type { MultikeyType } from './crypto/Multikey.js';

// Event system exports
export * from './events/index.js';

// Batch operations exports
export {
  BatchOperationExecutor,
  BatchValidator,
  BatchError,
  type BatchResult,
  type BatchOperationOptions,
  type BatchInscriptionOptions,
  type BatchInscriptionResult,
  type ValidationResult
} from './lifecycle/BatchOperations.js';

// Utility exports
export * from './utils/validation.js';
export * from './utils/satoshi-validation.js';
export * from './utils/serialization.js';
export * from './utils/retry.js';
export * from './utils/telemetry.js';

// Adapter exports (for testing and custom integrations)
export { OrdMockProvider } from './adapters/providers/OrdMockProvider.js';
export { FeeOracleMock } from './adapters/FeeOracleMock.js';
export type { OrdinalsProvider, FeeOracleAdapter, StorageAdapter } from './adapters/types.js';

// Default export
export default OriginalsSDK;