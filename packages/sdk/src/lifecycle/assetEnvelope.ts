/**
 * AssetEnvelope — the versioned, interchange format for an Originals asset (#377).
 *
 * The envelope's provenance IS the CEL: `eventLog` is the single source of truth,
 * and `bindings` / `currentLayer` / `migrations` / `transfers` are deliberately
 * NOT first-class fields — they are folds over the log (see replayProvenance).
 * Anything the log cannot derive (commitTxId, feeRate, post-genesis resource
 * updates, a btco binding not yet anchored by a witness proof) rides in the
 * `unverified` HONESTY SECTION: advisory-only, never trusted at load/verify time.
 */
import type { AssetResource, DIDDocument, VerifiableCredential } from '../types/index.js';
import type { EventLog } from '../cel/types.js';

export const ASSET_ENVELOPE_FORMAT = 'originals/asset' as const;
export const ASSET_ENVELOPE_VERSION = 1;

export interface AssetEnvelope {
  format: typeof ASSET_ENVELOPE_FORMAT;
  version: number;
  /** The did:cel genesis identifier; loadAsset's expectedDid, cross-checked vs the log. */
  assetDid: string;
  /** THE provenance encoding — embedded as a parsed object, round-trips via parseEventLogJson. */
  eventLog: EventLog;
  /** Per-layer DID documents captured at operation time. did:cel is always present. */
  didDocuments: {
    'did:cel': DIDDocument;
    'did:webvh'?: DIDDocument;
    'did:btco'?: DIDDocument;
  };
  /** Full resource shape, inline content included. */
  resources: AssetResource[];
  credentials?: VerifiableCredential[];
  /** HONESTY SECTION — advisory only, never verified/trusted. */
  unverified?: {
    commitTxId?: string;
    feeRate?: number;
    resourceUpdates?: Array<{
      resourceId: string;
      fromVersion: number;
      toVersion: number;
      fromHash: string;
      toHash: string;
      timestamp: string;
      changes?: string;
    }>;
    /** Live-cache btco binding, present ONLY when the fold can't derive it from the log. */
    bindings?: Record<string, string>;
  };
}
