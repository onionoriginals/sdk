/* istanbul ignore file */
import { OriginalsSDK } from './core/OriginalsSDK';

// Main exports
export { OriginalsSDK } from './core/OriginalsSDK';
export { OriginalsAsset } from './lifecycle/OriginalsAsset';
export type { ProvenanceChain } from './lifecycle/OriginalsAsset';

// Type exports
export * from './types';

// Manager exports
export { DIDManager } from './did/DIDManager';
export { KeyManager } from './did/KeyManager';
export { CredentialManager } from './vc/CredentialManager';
export { LifecycleManager } from './lifecycle/LifecycleManager';
export { BitcoinManager } from './bitcoin/BitcoinManager';
export { OrdinalsClient } from './bitcoin/OrdinalsClient';
export { BBSCryptosuiteUtils } from './vc/cryptosuites/bbs';
export { BbsSimple } from './vc/cryptosuites/bbsSimple';

// Crypto exports
export { Signer, ES256KSigner, Ed25519Signer, ES256Signer, Bls12381G2Signer } from './crypto/Signer';

// Utility exports
export * from './utils/validation';
export * from './utils/serialization';
export * from './utils/retry';
export * from './utils/telemetry';

// Adapters
export * from './adapters';

// Default export
export default OriginalsSDK;