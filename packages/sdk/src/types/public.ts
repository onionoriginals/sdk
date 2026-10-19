/** Public types of `@originals/sdk`, importable from `@originals/sdk/types`. */
export type * from '../originals/index.js';
export type { LayerType, KeyStore, ExternalSigner, ExternalVerifier, BitcoinSigner, OriginalsConfig, AssetResource, AssetResourceInput } from './common.js';
export type * from './did.js';
export type * from './credentials.js';
export type * from './bitcoin.js';
export type * from './network.js';
export type * from './multisig.js';
export type { OriginalResult, CreateOriginalOptions, UpdateOriginalOptions, CreateDIDOriginalOptions, UpdateDIDOriginalOptions, VerificationMethodInput } from '../did/identity-operations.js';
export type { SatSnapshot, BitcoinNetwork, ChainTip, CreationPosition, PublicationObservation, IndependentContentEvidence } from '../bitcoin/sat-snapshot-types.js';
export type { PreparedInscriptionOnSat, InscriptionRecoveryRecord, InscriptionRecoveryStore, InscriptionBroadcastState } from '../bitcoin/inscription-recovery.js';
export type { ChainValidator, BitcoinCoreChainValidatorOptions } from '../bitcoin/chain-validation.js';
export type { ContentValidator, BitcoinCoreContentValidatorOptions } from '../bitcoin/content-validation.js';
export type { OrdinalsProvider, FeeOracleAdapter, StorageAdapter } from '../adapters/types.js';
