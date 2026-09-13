/** CEL 3 SDK: local creation, authenticated resource bytes and verified interchange. */
export { OriginalsSDK, LifecycleManager } from "./OriginalsSDK.js";
export { OriginalsAsset } from "./OriginalsAsset.js";
export type * from "./types.js";
export { createLocalSigner, type CelSigner } from "@originals/cel/v3";
export { ASSET_LIMITS, ASSET_ENVELOPE_FORMAT, ASSET_ENVELOPE_VERSION } from "./envelope.js";

export type { SatProvider, AssetResolution, AssetResolutionOptions, AssetDIDResolution } from "./resolution.js";

export type { WebPublicationOptions, PreparedWebPublication, PublishedWebAsset, HostedEvidence, HostingEvidence, PublicReachabilityCheck, HostedAssetsOptions } from "./hosted.js";

export { fetchPublicReachabilityCheck } from "./hosted.js";

export type { BitcoinPublicationOptions, PreparedBitcoinPublication, BitcoinSubmissionOptions, SubmittedBitcoinAsset } from "./bitcoin.js";

export { readEnvelope as parseAssetEnvelope, inspectAssetEnvelope, type AssetEnvelopeInspection } from "./envelope.js";
