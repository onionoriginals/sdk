/**
 * Witnesses for hosted Originals (P9.8; plan 011, PR 7a).
 *
 * `WitnessClient` is what the SDK asks for an approval. `OriginalsWitness` is
 * the reference witness. Before approving the last entry of a submitted log it:
 *
 * - verifies the log under the Originals profile;
 * - obtains the author DID's latest state from its own source, never from the
 *   request, and refuses unless that state is no more than 60 seconds old;
 * - refuses an entry whose signing key that state does not list, and every
 *   entry once the author DID is deactivated;
 * - refuses an entry that changes the witness parameter to anything but the
 *   declaration in that latest state (P9.9);
 * - refuses an entry that does not extend the last entry it approved for the
 *   Original, unless it extends a threshold-witnessed entry that is not an
 *   ancestor of that last entry.
 *
 * It records the approval in its ledger before returning the proof. The
 * in-memory ledger suits tests; a deployed witness needs a durable one.
 * Witness independence from the host is governance, not code (D3).
 */
import { OriginalsError, type ErrorCategory } from "@originals/vh";
import { localSigner, type DataIntegrityProof, type ProofSigner } from "@originals/vh/crypto";
import { canonicalize, isJsonObject, parseJson, type JsonObject } from "@originals/vh/json";
import { createWitnessProof, type LogEntry, type WitnessFileEntry } from "@originals/vh/log";
import { fetchWebvhEvidence, type HostedFetch } from "./hosting.js";
import {
  authorKey,
  namedVersion,
  stillAuthorized,
  verifyAuthorHistory,
  verifyOriginal,
  witnessDeclaration,
  type AuthorDidEvidence,
  type EntryState,
} from "@originals/vh/originals";

export interface WitnessRequest {
  /** The Original's did:vh. */
  original: string;
  /** The asset log, ending with the entry to approve. */
  log: string;
  /** Witness proofs for the earlier entries. */
  witness: WitnessFileEntry[];
}

export interface WitnessClient {
  /** The witness's did:key, as the author DID's declaration lists it. */
  readonly id: string;
  /** Approve the last entry of `request.log`, or throw an `OriginalsError` saying why not. */
  approve(request: WitnessRequest): Promise<DataIntegrityProof>;
}

/** The author DID's latest state as the witness itself retrieved it. */
export type AuthorStateSource = (did: string) => Promise<{ evidence: AuthorDidEvidence; retrievedAt: number } | undefined>;

/** The versionIds of the log a witness last approved, per Original. */
export interface WitnessLedger {
  get(original: string): Promise<string[] | undefined>;
  put(original: string, versionIds: string[]): Promise<void>;
}

export class MemoryWitnessLedger implements WitnessLedger {
  private readonly approved = new Map<string, string[]>();

  get(original: string): Promise<string[] | undefined> {
    return Promise.resolve(this.approved.get(original)?.slice());
  }

  put(original: string, versionIds: string[]): Promise<void> {
    this.approved.set(original, versionIds.slice());
    return Promise.resolve();
  }
}

export interface OriginalsWitnessOptions {
  /** The Ed25519 secret key behind the witness's did:key (eddsa-jcs-2022 only; plan 011, S3). */
  secretKey: Uint8Array;
  authors: AuthorStateSource;
  ledger?: WitnessLedger;
  clock?: () => number;
  /** How old the author DID state may be. P9.8 allows no more than 60 seconds. */
  maxAuthorStateAgeMs?: number;
}

export const MAX_AUTHOR_STATE_AGE_MS = 60_000;

function refuse(category: ErrorCategory, code: string, message: string): never {
  throw new OriginalsError(category, code, message);
}

function linesOf(log: string): string[] {
  return log.length === 0 ? [] : log.trimEnd().split("\n");
}

export class OriginalsWitness implements WitnessClient {
  readonly id: string;
  private readonly signer: ProofSigner;
  private readonly ledger: WitnessLedger;
  private readonly clock: () => number;
  private readonly maxAge: number;

  private constructor(private readonly options: OriginalsWitnessOptions) {
    this.signer = localSigner("Ed25519", options.secretKey);
    this.id = `did:key:${this.signer.publicKeyMultibase}`;
    this.ledger = options.ledger ?? new MemoryWitnessLedger();
    this.clock = options.clock ?? (() => Date.now());
    this.maxAge = Math.min(options.maxAuthorStateAgeMs ?? MAX_AUTHOR_STATE_AGE_MS, MAX_AUTHOR_STATE_AGE_MS);
  }

  static create(options: OriginalsWitnessOptions): OriginalsWitness {
    return new OriginalsWitness(options);
  }

  async approve(request: WitnessRequest): Promise<DataIntegrityProof> {
    const lines = linesOf(request.log);
    if (lines.length === 0) refuse("invalid-evidence", "ENTRY_INVALID", "the log is empty");
    const entries = lines.map((line) => parseJson(line) as unknown as LogEntry);
    const entry = entries[entries.length - 1];
    const state = entry.state as unknown as EntryState;
    const authorDid = state.author?.did;
    if (typeof authorDid !== "string") refuse("invalid-evidence", "ENTRY_INVALID", "the entry names no author DID");

    // The list that must approve this entry: the one active before it, or the one it activates (VH-Log).
    let governing: JsonObject = {};
    for (const e of entries) {
      const w = e.parameters?.witness;
      if (e === entry && Object.keys(governing).length > 0) break;
      if (isJsonObject(w)) governing = w;
    }
    const listed = Array.isArray(governing.witnesses) && governing.witnesses.some((w) => isJsonObject(w) && w.id === this.id);
    if (!listed) refuse("invalid-evidence", "NOT_A_WITNESS", `${this.id} is not a witness of this entry`);

    // The author DID's latest state, from the witness's own source (P9.8).
    const now = this.clock();
    const latest = await this.options.authors(authorDid);
    if (!latest) refuse("incomplete-evidence", "AUTHOR_STATE_UNAVAILABLE", `the witness cannot obtain ${authorDid}`);
    if (now - latest.retrievedAt > this.maxAge || latest.retrievedAt > now) {
      refuse("incomplete-evidence", "AUTHOR_STATE_STALE", `the witness's state of ${authorDid} is more than ${this.maxAge / 1000} seconds old`);
    }
    const history = await verifyAuthorHistory(latest.evidence, { now });
    const current = history.versions[history.versions.length - 1];
    if (!current || history.failure) refuse("incomplete-evidence", "AUTHOR_STATE_UNAVAILABLE", `the witness's state of ${authorDid} does not verify`);
    if (current.deactivated) refuse("deactivated", "AUTHOR_DEACTIVATED", `${authorDid} is deactivated`);

    // The entry under the profile, with every earlier entry already witnessed.
    const report = await verifyOriginal({ log: request.log, authors: [latest.evidence], witnessFile: request.witness, now, freshness: "asserted" });
    const pending = report.history.failure?.code === "WITNESS_THRESHOLD" && report.history.failure.index === entries.length - 1;
    const approvedBefore = report.history.status === "valid" && report.head === entry.versionId;
    if (report.original !== request.original || !(pending || approvedBefore)) {
      refuse("invalid-evidence", "ENTRY_INVALID", `the entry does not verify: ${report.history.failure?.message ?? report.reasons.join(", ")}`);
    }

    const key = authorKey(namedVersion(history, state.author), state.author);
    if (!stillAuthorized(current, state.author, key)) {
      refuse("unauthorized-key", "KEY_NOT_IN_LATEST", "the author DID's latest state does not list the entry's signing key");
    }
    const set = entry.parameters?.witness;
    if (isJsonObject(set) && Object.keys(set).length > 0) {
      const declared = witnessDeclaration(current);
      if (!declared || canonicalize(declared) !== canonicalize(set)) {
        refuse("invalid-evidence", "WITNESS_NOT_LATEST_DECLARATION", "the entry's witnesses are not those the author DID declares now (P9.9)");
      }
    }

    // Extends the last entry this witness approved for the Original.
    const ids = entries.map((e) => e.versionId);
    const last = await this.ledger.get(request.original);
    if (last && !last.includes(entry.versionId)) {
      const parent = ids[ids.length - 2];
      const extendsLast = parent !== undefined && parent === last[last.length - 1];
      const witnessedFrom = report.witnessedFrom ? ids.indexOf(report.witnessedFrom) : -1;
      const parentWitnessed = witnessedFrom >= 0 && witnessedFrom <= ids.length - 2;
      if (!extendsLast && !(parentWitnessed && !last.includes(parent))) {
        refuse("fork", "NOT_EXTENDING_LAST_APPROVED", `the entry does not extend ${last[last.length - 1]}, the last entry this witness approved`);
      }
    }
    if (!last || !last.includes(entry.versionId)) await this.ledger.put(request.original, ids);
    return createWitnessProof(this.signer, entry.versionId, "eddsa-jcs-2022", new Date(now).toISOString());
  }
}

/**
 * An author state source that reads did:webvh author DIDs from where they are
 * published, each time it is asked (P9.8: never from the request). Other
 * methods have no location to read, so the witness refuses their entries.
 */
export function webvhAuthorSource(fetch: HostedFetch, clock: () => number = () => Date.now()): AuthorStateSource {
  return async (did) => {
    if (!did.startsWith("did:webvh:")) return undefined;
    try {
      return { evidence: await fetchWebvhEvidence(did, fetch), retrievedAt: clock() };
    } catch (error) {
      if (error instanceof OriginalsError) return undefined;
      throw error;
    }
  };
}
