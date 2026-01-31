/**
 * Originals SDK v2
 * 
 * Clean, minimal implementation of the Originals Protocol.
 */

// Types
export type {
  // Core
  Original,
  Resource,
  EventLog,
  LogEntry,
  Layer,
  Network,
  
  // Events
  EventData,
  CreateEvent,
  UpdateEvent,
  MigrateEvent,
  DeactivateEvent,
  
  // Crypto
  Proof,
  WitnessProof,
  KeyPair,
  KeyType,
  Signer,
  Verifier,
  
  // DID
  DIDDocument,
  VerificationMethod,
  Service,
  
  // Config
  OriginalsConfig,
} from './types'

// Core operations
export {
  create,
  update,
  migrate,
  deactivate,
  verify,
  type CreateOptions,
  type UpdateOptions,
  type MigrateOptions,
  type DeactivateOptions,
  type VerifyOptions,
  type VerifyResult,
} from './originals'

// Crypto
export {
  hash,
  verifyHash,
  generateKeyPair,
  createSigner,
  createVerifier,
  verifyProof,
} from './crypto'

// DID
export {
  createPeerDID,
  createWebVHDID,
  createBtcoDID,
  createDIDDocument,
  resolveDID,
  getLayerFromDID,
  isValidDID,
} from './did'

// Bitcoin
export {
  inscribeOriginal,
  inscribeEventLog,
  fetchOriginal,
  fetchEventLog,
  estimateInscriptionFee,
  parseInscriptionId,
  type InscriptionData,
  type InscriptionResult,
  type OrdinalsProvider,
} from './bitcoin'

// WebVH
export {
  publish,
  updateWebVH,
  resolveWebVH,
  deactivateWebVH,
  serializeLog,
  parseLog,
  getHostingPath,
  type PublishOptions,
  type PublishResult,
  type UpdateWebVHOptions,
  type DeactivateWebVHOptions,
} from './webvh'
