/**
 * `@originals/sdk/originals`: the Originals Protocol SDK, local slice (plan
 * 011, PR 4). It replaces the CEL 3 asset API, which PR 5 deletes. Browser-safe;
 * the file store is in `@originals/sdk/originals/fs`.
 */
export * from "./sdk.js";
export * from "./signer.js";
export * from "./store.js";
export * from "./evidence.js";
export { readZip, writeZip, crc32, checkArchivePath, ZIP_LIMITS, type ZipLimits } from "./zip.js";
export * from "./hosting.js";
export * from "./shared.js";
// Browser-safe helpers web apps used to copy: hosted reads, shared-host transport, publication, reasons.
export * from "./web.js";
export * from "./bitcoin.js";
// The guided path: Create → Add a version → Export → Verify, with a local author (OriginalsStudio).
export * from "./guided.js";
export { isVerified, verdictLine } from "./verdict.js";
// What callers of this module need from @originals/vh, so they import from the SDK alone.
export { OriginalsError, type ErrorCategory } from "@originals/vh";
export type {
  AssetState, AuthorDidEvidence, AuthorRef, AuthorSet, EditorGrant, EditorRef, OriginalsReport, ParentRef, ResourceVersion, ValidAsOf,
} from "@originals/vh/originals";
// What an Originals inscription carries and what the author is told before one (P9.17, P9.18, P14.12).
export {
  inscriptionMetadata, descriptorOfLine, previewOfLine, isActiveContent, inscriptionNotice,
  type InscriptionNotice, type InscribedBody, type InscriptionCost, type NotOnBitcoin,
} from "./inscription.js";
// Bitcoin previews (P9.30): the WebP preview of an image version, its codecs loaded only when one is made.
export {
  generateImagePreview, configurePreviewCodecs, PREVIEW_CODEC_ATTEMPTS, PREVIEW_CODEC_RETRY_DELAYS_MS, PREVIEW_MAX_BYTES, PREVIEW_EDGES, PREVIEW_QUALITIES, PREVIEW_FAIR_QUALITY,
  type GeneratedPreview, type PreviewFailure, type PreviewResult, type PreviewReport, type GeneratePreviewOptions, type PreviewCodecConfig, type ImageFormat,
} from "./preview.js";
