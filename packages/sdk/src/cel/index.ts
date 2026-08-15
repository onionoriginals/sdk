/**
 * CEL (Cryptographic Event Log) Module
 * 
 * Implements W3C CCG CEL Specification for Originals Protocol
 * @see https://w3c-ccg.github.io/cel-spec/
 */

export * from './types.js';
export * from './hash.js';
export * from './canonicalize.js';
export { DID_CEL_PREFIX, deriveDidCel, deriveDidCelFromGenesis, isDidCel, didCelMatchesLog, createCelDidDocument, resolveDidCel } from './celDid.js';
export * from './algorithms/index.js';
export * from './witnesses/index.js';
export * from './serialization/index.js';
export * from './ExternalReferenceManager.js';
export * from './layers/index.js';
export * from './OriginalsCel.js';
export * from './keyResolver.js';
export {
  celSignerFromKeyPair,
  createKeyStoreCelSigner,
  currentControllerVm,
  hexSha256ToDigestMultibase,
} from './signerAdapter.js';
// The CLI is intentionally NOT re-exported here. It statically imports fs and
// path and pulls in all of OriginalsSDK, which would make this barrel — the
// genesis-only entry point for browser consumers — unloadable outside Node.
// It ships as the `originals-cel` bin (dist/cel/cli/index.js) instead.
