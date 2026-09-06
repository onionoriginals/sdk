/** CEL 3 SDK: local creation, authenticated resource bytes and verified interchange. */
export { OriginalsSDK, LifecycleManager } from "./OriginalsSDK.js";
export { OriginalsAsset } from "./OriginalsAsset.js";
export type * from "./types.js";
export { createLocalSigner, type CelSigner } from "@originals/cel/v3";
export { ASSET_LIMITS, ASSET_ENVELOPE_FORMAT, ASSET_ENVELOPE_VERSION } from "./envelope.js";
