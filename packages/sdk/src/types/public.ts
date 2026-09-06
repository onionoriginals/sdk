/** Public types match the default CEL 3 asset API. */
export type * from './index.js';
export type { OriginalsSDKOptions, OriginalsConfig } from '../core/OriginalsSDK3.js';
export type { AssetResource, AssetResourceInput, AssetEnvelope, AssetUpdate, AssetVerification, MutationOptions, MutationResult, LoadedAsset, LoadAssetOptions, CreateAssetOptions, LocalResource } from '../v3/types.js';
export type { CelSigner, AssetState, VerifiedHistory } from '@originals/cel/v3';
