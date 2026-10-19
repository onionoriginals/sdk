/**
 * @originals/vh — Verifiable History for the Originals Protocol.
 *
 * Subpaths: `./json` (strict JSON, JCS), `./crypto` (Multikey, eddsa-jcs-2022,
 * bip340-jcs-2025), `./log` (the VH-Log engine), `./didvh` (did:vh resolution
 * and extensions). The root re-exports the error contract and each layer.
 */
export * from "./errors.js";
export * from "./json/index.js";
export * from "./crypto/index.js";
export * from "./log/index.js";
export * from "./didvh/index.js";
