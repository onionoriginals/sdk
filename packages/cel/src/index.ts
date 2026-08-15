/**
 * @originals/cel — Cryptographic Event Log core
 *
 * Implements W3C CCG CEL Specification for Originals Protocol.
 * Browser-safe: no Bitcoin stack, no jsonld, no Node builtins.
 * @see https://w3c-ccg.github.io/cel-spec/
 */

export * from './types.js';
export * from './hash.js';
export * from './canonicalize.js';
export { DID_CEL_PREFIX, deriveDidCel, deriveDidCelFromGenesis, isDidCel, didCelMatchesLog, createCelDidDocument, resolveDidCel } from './celDid.js';
export * from './btcoDid.js';
export * from './resourceHead.js';
export * from './algorithms/index.js';
export * from './witnesses/index.js';
export * from './serialization/index.js';
export * from './ExternalReferenceManager.js';
// The CEL suite labels (plan 042): one written, one accepted for pre-042 logs.
export {
  CEL_CRYPTOSUITE,
  CEL_CRYPTOSUITE_LEGACY,
  verifyDidKeyProof,
  structuralCheckReason,
} from './proofVerification.js';
export * from './layers/index.js';
export * from './OriginalsCel.js';
export * from './keyResolver.js';
export {
  celSignerFromKeyPair,
  createKeyStoreCelSigner,
  currentControllerVm,
  hexSha256ToDigestMultibase,
} from './signerAdapter.js';

// Shared primitives extracted with the CEL core. These are the CANONICAL
// definitions — @originals/sdk re-exports them, never redefines them.
export { multikey, validateMultikeyFormat } from './crypto/Multikey.js';
export type { MultikeyType } from './crypto/Multikey.js';
export * from './utils/telemetry.js';
export * from './utils/satoshi-validation.js';
export { sha256Bytes, hashResource } from './utils/hash.js';
export { validateDID, validateDIDDocument } from './utils/validation.js';
// Namespaced: their member names (encode/decode, multikey, base58…) would
// collide with the flat exports above. Also importable as subpaths
// '@originals/cel/encoding' and '@originals/cel/cbor'.
export * as encoding from './utils/encoding.js';
export * as cbor from './utils/cbor.js';
export type { DataIntegrityProof } from './types/proof.js';
export type { DIDDocument, VerificationMethod, ServiceEndpoint } from './types/did.js';
export type { KeyStore, KeyPair } from './types/keys.js';
