/**
 * CEL (Cryptographic Event Log) Types
 *
 * Based on W3C CCG CEL Specification v0.1
 * @see https://w3c-ccg.github.io/cel-spec/
 */

// Re-export canonical DataIntegrityProof from shared types
import type { DataIntegrityProof } from '../types/proof.js';
export type { DataIntegrityProof } from '../types/proof.js';

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
export type EventType = 'create' | 'update' | 'deactivate' | 'migrate' | 'transfer' | 'rotateKey';

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
  /**
   * Present when this rotateKey event was accepted via the NON-COOPERATIVE
   * path (#366): its controller proof was not authorized by the current key
   * set, but a fully verified reinscription on the log's anchored satoshi
   * attested the authority hand-off. Carries the rotation's inscriptionId
   * (the new on-sat authority anchor). Absent for cooperative rotations.
   */
  nonCooperativeRotation?: { inscriptionId: string };
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
  /**
   * The asset DID this log backs, when derivable from the genesis event:
   * the DERIVED `did:cel:<digest>` for new-shape (`data.controller`) logs, or
   * the declared `data.did` for legacy logs. Absent for shapeless logs.
   * Informational: it is a trust statement only when `verified` is true.
   */
  assetDid?: string;
}

/**
 * Options for creating a new event log
 */
export interface CreateOptions {
  /** Signer function that produces a proof */
  signer: (data: unknown) => Promise<DataIntegrityProof>;
  /**
   * The verification method DID URL — advisory: the recorded VM comes from
   * the signer's proof; managers use this only to construct fallback VM
   * strings.
   */
  verificationMethod: string;
  /** The proof purpose (defaults to "assertionMethod") */
  proofPurpose?: string;
}

/**
 * Options for updating an event log
 */
export type UpdateOptions = CreateOptions;

/**
 * Options for deactivating an event log
 */
export type DeactivateOptions = CreateOptions;

/**
 * Minimal ordinals lookup surface needed to verify bitcoin witness proofs.
 * Structurally compatible with the SDK's OrdinalsProvider adapter interface.
 */
export interface OrdinalsLookup {
  getInscriptionById(id: string): Promise<{
    inscriptionId: string;
    // Optional: deferred-content providers may not echo built content back.
    content?: Buffer;
    contentType: string;
    txid?: string;
    satoshi?: string;
  } | null>;
  getInscriptionsBySatoshi?(satoshi: string): Promise<Array<{ inscriptionId: string }>>;
}

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
  /**
   * Ordinals provider used to verify `bitcoin-ordinals-2024` witness proofs
   * against the Bitcoin chain. btco anchoring is GATING: a log that carries a
   * bitcoin witness proof fails verification unless the proof's inscription
   * exists, is carried by the claimed satoshi, and its content commits to the
   * event's digest — and that check requires this provider. Logs without
   * bitcoin witness proofs verify without it. (Skipped on the custom
   * `verifier` path, where the caller owns proof semantics.)
   */
  ordinalsProvider?: OrdinalsLookup;
  /**
   * When set, the log must back this exact asset DID or verification fails.
   * did:cel expected DIDs are compared via suffix derivation
   * (`didCelMatchesLog`); legacy DIDs by string equality against `data.did`.
   * Ignored on the custom `verifier` path (which owns proof semantics).
   */
  expectedDid?: string;
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
  /** Current controller key DID: genesis `controller`, handed off by rotateKey */
  controller?: string;
  /** Creation timestamp */
  createdAt?: string;
  /** Last update timestamp */
  updatedAt?: string;
  /** Whether the asset has been deactivated */
  deactivated: boolean;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}
