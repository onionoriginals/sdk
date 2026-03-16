/**
 * Originals Protocol - Core Types
 * 
 * An Original is a digital asset with cryptographic provenance.
 * It has identity (DID), content (resources), and history (event log).
 */

// =============================================================================
// CORE
// =============================================================================

/** The three layers an Original can live on */
export type Layer = 'peer' | 'webvh' | 'btco'

/** Network environment */
export type Network = 'dev' | 'staging' | 'prod'

/** An Original - the fundamental unit */
export interface Original {
  did: string
  layer: Layer
  resources: Resource[]
  log: EventLog
  deactivated?: boolean
}

/** A resource (file/content) attached to an Original */
export interface Resource {
  id: string
  type: string           // 'image', 'text', 'code', etc.
  hash: string           // content hash (multihash)
  mediaType?: string     // MIME type
  url?: string[]         // where to fetch it
  size?: number
}

// =============================================================================
// EVENT LOG (Provenance Chain)
// =============================================================================

/** The complete history of an Original */
export interface EventLog {
  events: LogEntry[]
  previousLog?: string   // for chunking long histories
}

/** A single event in the log */
export interface LogEntry {
  type: 'create' | 'update' | 'migrate' | 'deactivate'
  data: EventData
  prev?: string          // hash of previous entry
  proof: Proof[]
}

/** Event-specific data */
export type EventData = CreateEvent | UpdateEvent | MigrateEvent | DeactivateEvent

export interface CreateEvent {
  did: string
  layer: Layer
  resources: Resource[]
  creator: string        // DID of creator
  createdAt: string      // ISO timestamp
  metadata?: Record<string, unknown>
}

export interface UpdateEvent {
  resources?: Resource[] // new/changed resources
  metadata?: Record<string, unknown>
  updatedAt: string
  reason?: string
}

export interface MigrateEvent {
  fromLayer: Layer
  toLayer: Layer
  newDid: string         // DID on new layer
  migratedAt: string
  txid?: string          // Bitcoin txid if migrating to btco
}

export interface DeactivateEvent {
  deactivatedAt: string
  reason?: string
}

// =============================================================================
// CRYPTOGRAPHY
// =============================================================================

/** A cryptographic proof */
export interface Proof {
  type: string           // e.g. 'DataIntegrityProof'
  suite: string          // e.g. 'eddsa-jcs-2022'
  created: string
  method: string         // verification method DID URL
  purpose: string        // e.g. 'assertionMethod'
  value: string          // multibase signature
}

/** Witness proof - third party attestation */
export interface WitnessProof extends Proof {
  witnessedAt: string
}

/** Supported key types */
export type KeyType = 'Ed25519' | 'secp256k1' | 'P-256'

/** A key pair */
export interface KeyPair {
  type: KeyType
  publicKey: string      // multibase
  privateKey: string     // multibase
}

// =============================================================================
// DID
// =============================================================================

/** Minimal DID Document */
export interface DIDDocument {
  id: string
  controller?: string[]
  verificationMethod?: VerificationMethod[]
  authentication?: string[]
  assertionMethod?: string[]
  service?: Service[]
}

export interface VerificationMethod {
  id: string
  type: string
  controller: string
  publicKeyMultibase: string
}

export interface Service {
  id: string
  type: string
  serviceEndpoint: string | Record<string, unknown>
}

// =============================================================================
// SDK CONFIG
// =============================================================================

export interface OriginalsConfig {
  network: Network
  keyType?: KeyType      // default: Ed25519
}

// =============================================================================
// EXTERNAL INTERFACES
// =============================================================================

/** Sign data, return proof */
export interface Signer {
  sign(data: unknown): Promise<Proof>
  getVerificationMethod(): string
}

/** Verify a proof */
export interface Verifier {
  verify(proof: Proof, data: unknown): Promise<boolean>
}
