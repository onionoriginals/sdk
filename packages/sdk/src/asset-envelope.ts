// Offline envelope validation without loading hosting, Bitcoin, or custody modules.
export { readEnvelope as parseAssetEnvelope, inspectAssetEnvelope, type AssetEnvelopeInspection } from "./v3/envelope.js";
export type { AssetEnvelope } from "./v3/types.js";
