/**
 * @originals/cel — Cryptographic Event Log core
 *
 * Implements W3C CCG CEL Specification for Originals Protocol.
 * Browser-safe: no Bitcoin stack, no jsonld, no Node builtins.
 * @see https://w3c-ccg.github.io/cel-spec/
 */

export * from './types.js';
export * from './hash.js';
// canonicalizeEvent and its derivatives are previous-format-only (issue #599)
// and are intentionally not exported from this root; import them from
// '@originals/cel/legacy'.
export { DID_CEL_PREFIX, deriveDidCel, deriveDidCelFromGenesis, isDidCel, didCelMatchesLog, createCelDidDocument, resolveDidCel } from './celDid.js';
export * from './btcoDid.js';
export * from './resourceHead.js';
// The previous-format event-log algorithms (createEventLog, appendEvent,
// updateEventLog, deactivateEventLog, verifyEventLog, witnessEvent, the
// custody-fold helpers) are not exported from this root either (issue #597):
// import them from '@originals/cel/legacy'.
export * from './witnesses/index.js';
export * from './serialization/index.js';
export * from './ExternalReferenceManager.js';
// The CEL proof labels: one written, one accepted for logs sealed under the
// previous name. The suite pair is plan 042; the type pair renames the claim
// `DataIntegrityProof` made and never implemented.
export {
  CEL_CRYPTOSUITE,
  CEL_CRYPTOSUITE_LEGACY,
  CEL_PROOF_TYPE,
  CEL_PROOF_TYPE_LEGACY,
  CEL_PROOF_TYPES,
  isCelProofType,
  verifyDidKeyProof,
  structuralCheckReason,
} from './proofVerification.js';
// PeerCelManager / WebVHCelManager / BtcoCelManager, OriginalsCel (which
// wraps all three), and the previous-format signer helpers (celSignerFromKeyPair,
// createKeyStoreCelSigner, currentControllerVm, hexSha256ToDigestMultibase) are
// the previous-format writer surface (issue #597) and live behind
// '@originals/cel/legacy' only, so a new consumer importing this root cannot
// reach a previous-format writer and mistake it for the canonical one.
export * from './keyResolver.js';

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
export type { DIDDocument, VerificationMethod, VerificationMethodInput, ServiceEndpoint } from './types/did.js';
export type { KeyStore, KeyPair } from './types/keys.js';

// The explicit new-format core. Existing consumers move here in the SDK migration stage.
export * as celV3 from './v3/index.js';
