/** Public types match the default CEL 3 asset API. */
export type * from './index.js';
export type { OriginalsSDKOptions, OriginalsConfig } from '../core/OriginalsSDK3.js';
export type { AssetResource, AssetResourceInput, AssetEnvelope, AssetUpdate, AssetVerification, MutationOptions, MutationResult, LoadedAsset, LoadAssetOptions, CreateAssetOptions, LocalResource } from '../v3/types.js';
export type { CelSigner, AssetState, VerifiedHistory } from '@originals/cel/v3';
export type { SatProvider, AssetResolution, AssetResolutionOptions, AssetDIDResolution } from '../v3/resolution.js';
export type { WebPublicationOptions, PreparedWebPublication, PublishedWebAsset } from '../v3/hosted.js';
export type { BitcoinPublicationOptions, PreparedBitcoinPublication, BitcoinSubmissionOptions, SubmittedBitcoinAsset } from '../v3/bitcoin.js';
export type { PreparedInscriptionOnSat, InscriptionRecoveryRecord, InscriptionRecoveryStore, InscriptionBroadcastState } from '../bitcoin/inscription-recovery.js';
