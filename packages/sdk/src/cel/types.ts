/**
 * CEL (Cryptographic Event Log) Types
 *
 * Based on W3C CCG CEL Specification v0.1
 * @see https://w3c-ccg.github.io/cel-spec/
 */

// Re-export canonical DataIntegrityProof from shared types
import type { DataIntegrityProof } from '../types/proof';
export type { DataIntegrityProof } from '../types/proof';

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
  /**
   * True when all proofs for this event were cryptographically verified
   * (e.g. Ed25519 signature checked against the public key in a did:key VM).
   * False when only structural validation was possible — the proof fields were
   * well-formed but no signature check was performed.  Absent when a
   * caller-supplied custom verifier was used.
   */
  cryptographicallyVerified?: boolean;
  /**
   * Per-witness verification results. Witness proofs are cryptographically
   * checked when resolvable but are NON-GATING: a failed or unresolvable witness
   * does not affect `proofValid` / the log's overall `verified`. Empty/absent
   * when the event carries no witness proofs.
   */
  witnessProofs?: { verificationMethod: string; verified: boolean }[];
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
  /**
   * Resolves the Ed25519 public key bytes for a proof's verificationMethod.
   * Required to verify proofs whose key is NOT embedded in the identifier
   * (did:webvh, did:btco, did:peer). Return null when the method cannot be
   * resolved or its key is not Ed25519 — the proof then fails closed.
   */
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>;
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
