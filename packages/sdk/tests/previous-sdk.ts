/** Previous-format regression boundary. These tests do not establish CEL 3 behavior. */
export * from '../src/index.js';
export { OriginalsSDK } from '../src/core/OriginalsSDK.js';
export type { OriginalsSDKOptions } from '../src/core/OriginalsSDK.js';
export { OriginalsAsset } from '../src/lifecycle/OriginalsAsset.js';
export { LifecycleManager } from '../src/lifecycle/LifecycleManager.js';
export type { CostEstimate, LifecycleProgress, MigrationValidation, CreateAssetOptions, InscribeOnBitcoinOptions } from '../src/lifecycle/LifecycleManager.js';
export { ASSET_ENVELOPE_FORMAT, ASSET_ENVELOPE_VERSION } from '../src/lifecycle/assetEnvelope.js';
export type { AssetEnvelope } from '../src/lifecycle/assetEnvelope.js';
export type { OriginalsConfig, AssetResource, AssetResourceInput } from '../src/types/common.js';
export { toCelSigner } from '../src/crypto/OriginalsSigner.js';
// CEL (Cryptographic Event Log) exports
export {
  OriginalsCel,
  type CelLayer,
  type CelSigner,
  type OriginalsCelConfig,
  type OriginalsCelOptions,
} from '@originals/cel';
export type {
  EventLog,
  LogEntry,
  EventType,
  DataIntegrityProof,
  WitnessProof,
  ExternalReference,
  VerificationResult,
  EventVerification,
  AssetState,
  CreateOptions,
  UpdateOptions,
  DeactivateOptions,
  VerifyOptions,
} from '@originals/cel';
export {
  createEventLog,
  updateEventLog,
  deactivateEventLog,
  verifyEventLog,
  witnessEvent,
} from '@originals/cel';
export {
  computeDigestMultibase,
  verifyDigestMultibase,
  decodeDigestMultibase,
  digestMultibaseEquals,
} from '@originals/cel';
export { witnessSigningBytes, celProofSigningInput, canonicalizeEvent } from '@originals/cel';
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
} from '@originals/cel';
export {
  DID_CEL_PREFIX,
  deriveDidCel,
  deriveDidCelFromGenesis,
  isDidCel,
  didCelMatchesLog,
  createCelDidDocument,
  resolveDidCel,
} from '@originals/cel';
export {
  createExternalReference,
  verifyExternalReference,
} from '@originals/cel';
export {
  PeerCelManager,
  type CelAssetData,
  type PeerAssetData,
  type PeerCelConfig,
} from '@originals/cel/legacy';
export { WebVHCelManager } from '@originals/cel/legacy';
export { BtcoCelManager } from '@originals/cel/legacy';
export type { WitnessService } from '@originals/cel';
export { HttpWitness, HttpWitnessError } from '@originals/cel';
export { BitcoinWitness, BitcoinWitnessError, type BitcoinWitnessProof } from '@originals/cel';
export {
  serializeEventLogJson,
  parseEventLogJson,
} from '@originals/cel';
export {
  serializeEventLogCbor,
  parseEventLogCbor,
} from '@originals/cel';
export {
  celSignerFromKeyPair,
  createKeyStoreCelSigner,
  currentControllerVm,
  hexSha256ToDigestMultibase,
} from '@originals/cel';
