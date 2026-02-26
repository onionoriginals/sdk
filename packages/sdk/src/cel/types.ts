/**
 * CEL (Cryptographic Event Log) Types
 * 
 * Based on W3C CCG CEL Specification v0.1
 * @see https://w3c-ccg.github.io/cel-spec/
 */

/**
 * Data Integrity Proof as defined in W3C Data Integrity spec
 * Used for signing events and witness attestations
 */
export interface DataIntegrityProof {
  /** The type of proof (e.g., "DataIntegrityProof") */
  type: string;
  /** The cryptosuite used (e.g., "eddsa-jcs-2022") */
  cryptosuite: string;
  /** ISO 8601 timestamp when the proof was created */
  created: string;
  /** DID URL of the verification method used to create the proof */
  verificationMethod: string;
  /** The purpose of the proof (e.g., "assertionMethod") */
  proofPurpose: string;
  /** The multibase-encoded proof value */
  proofValue: string;
}

/**
 * Required v1.1 operation names for provenance-changing events.
 */
export type RequiredEventOperation = 'ResourceAdded' | 'ResourceUpdated';

/**
 * Minimal semantic event payload contract for v1.1 required events.
 * Field names may vary in external payloads; algorithms normalize to this shape.
 */
export interface V11EventPayload {
  operation: RequiredEventOperation;
  [key: string]: unknown;
}

/**
 * Witness Proof - extends DataIntegrityProof with witness-specific fields
 * Used when a third party attests to the existence of an event at a point in time
 */
export interface WitnessProof extends DataIntegrityProof {
  /** ISO 8601 timestamp when the witness attested to the event */
  witnessedAt: string;
}

/**
 * External Reference - points to data outside the event log
 * Used for large resources that shouldn't be embedded in the log
 */
export interface ExternalReference {
  /** Optional URLs where the data can be retrieved */
  url?: string[];
  /** Optional MIME type of the data */
  mediaType?: string;
  /** Required Multibase-encoded (base64url-nopad) Multihash (sha2-256) of the data */
  digestMultibase: string;
}

/**
 * Event type for log entries
 */
export type EventType = 'create' | 'update' | 'deactivate';

/**
 * Log Entry - a single event in the cryptographic event log
 * Contains the event data, proof(s), and chain reference
 */
export interface LogEntry {
  /** The type of event */
  type: EventType;
  /** The event data (schema varies by event type) */
  data: unknown;
  /** Multibase-encoded hash of the previous event (omitted for first event) */
  previousEvent?: string;
  /** One or more proofs attesting to this event (controller proof + optional witness proofs) */
  proof: (DataIntegrityProof | WitnessProof)[];
}

/**
 * Event Log - the complete cryptographic event log
 * Contains a list of hash-chained events with optional chunking support
 */
export interface EventLog {
  /** The list of events in chronological order */
  events: LogEntry[];
  /** Optional reference to a previous log file (for chunking long histories) */
  previousLog?: string;
}

/**
 * Verification result for a single event
 */
export interface EventVerification {
  /** Index of the event in the log */
  index: number;
  /** The event type */
  type: EventType;
  /** Whether the event's proofs are valid */
  proofValid: boolean;
  /** Whether the hash chain link is valid (previousEvent matches) */
  chainValid: boolean;
  /** Any errors encountered during verification */
  errors: string[];
}

/**
 * Result of verifying an entire event log
 */
export interface VerificationResult {
  /** Whether the entire log is valid */
  verified: boolean;
  /** List of errors encountered */
  errors: string[];
  /** Per-event verification details */
  events: EventVerification[];
}

/**
 * Options for creating a new event log
 */
export interface CreateOptions {
  /** Signer function that produces a proof */
  signer: (data: unknown) => Promise<DataIntegrityProof>;
  /** The verification method DID URL */
  verificationMethod: string;
  /** The proof purpose (defaults to "assertionMethod") */
  proofPurpose?: string;
}

/**
 * Options for updating an event log
 */
export interface UpdateOptions extends CreateOptions {}

/**
 * Options for deactivating an event log
 */
export interface DeactivateOptions extends CreateOptions {}

/**
 * Options for verifying an event log
 */
export interface VerifyOptions {
  /** Optional custom proof verifier */
  verifier?: (proof: DataIntegrityProof, data: unknown) => Promise<boolean>;
}

/**
 * Asset state derived from replaying event log
 */
export interface AssetState {
  /** Current DID of the asset */
  did: string;
  /** Asset name */
  name?: string;
  /** Current layer (peer, webvh, btco) */
  layer: 'peer' | 'webvh' | 'btco';
  /** External resources associated with the asset */
  resources: ExternalReference[];
  /** Creator DID */
  creator?: string;
  /** Creation timestamp */
  createdAt?: string;
  /** Last update timestamp */
  updatedAt?: string;
  /** Whether the asset has been deactivated */
  deactivated: boolean;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}
