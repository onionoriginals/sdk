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
export * from "./witness.js";
export * from "./hosting.js";
