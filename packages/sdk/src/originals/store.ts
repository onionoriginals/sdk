/**
 * The durable local commit contract (P6.2). An Original's committed history is
 * its log; the SDK stores new resource bytes first and then replaces the log
 * in one atomic step, conditional on the head it built on. An interrupted
 * commit therefore leaves the prior log or the new one, never a checkpoint
 * whose bytes were not stored. Staged bytes may remain; they are content
 * addressed and are never a committed version on their own (P6.1).
 *
 * A store also keeps what freshness checks need (P7.8): the highest versionId
 * verified for each Original and each author DID, and any valid branch that
 * diverges from the committed log, so a fork stays visible (P6.6, Q5).
 *
 * After a shared host refuses a save with a stale-parent conflict, the store
 * keeps the refused signed candidate, labelled `refused`, beside the
 * committed log and never in it (P6.8). Nothing that reads the committed log
 * (verification, packaging, hosted files) sees it.
 */
import { OriginalsError } from "@originals/vh";
import { parseJson } from "@originals/vh/json";
import type { AuthorDidEvidence } from "@originals/vh/originals";

export interface StoredOriginal {
  /** The committed asset log, `did.jsonl` text. */
  log: string;
  /** The witness proofs file, once witnesses exist (plan 011, PR 7). */
  witness?: unknown;
}

export interface CommitUpdate {
  /** The head the new log extends; null for a new Original. */
  expectedHead: string | null;
  log: string;
  witness?: unknown;
}

/**
 * A signed candidate a shared host refused with a stale-parent conflict
 * (P6.7, P6.8). It is a valid entry with the same parent as an accepted one,
 * so it is never history: it is kept so the signer's intended change is not
 * lost, and reconciled into a new candidate against the new head.
 */
export interface StoredRefused {
  label: "refused";
  /** The checkpoint it was signed against. */
  parent: string;
  /** The refused signed entry, exactly as submitted: one JSON line without a newline. */
  entry: string;
  /** The host's head when it refused. */
  hostHead: string;
  /** The accepted candidate that carried its change, once reconciled (P6.8). The refused entry is kept either way. */
  reconciledAs?: string;
}

export interface OriginalsStore {
  get(did: string): Promise<StoredOriginal | undefined>;
  /** Atomically replace the log if the stored head is `expectedHead`; otherwise a stale-parent conflict. */
  commit(did: string, update: CommitUpdate): Promise<void>;
  putResource(digest: string, bytes: Uint8Array): Promise<void>;
  getResource(digest: string): Promise<Uint8Array | undefined>;
  /** Keep author DID evidence that arrived with imported Originals. Verified on every read. */
  putAuthorEvidence(evidence: AuthorDidEvidence): Promise<void>;
  getAuthorEvidence(did: string): Promise<AuthorDidEvidence | undefined>;
  /** The highest versionId verified for an Original or an author DID. The SDK never lowers it. */
  getRetained(did: string): Promise<string | undefined>;
  putRetained(did: string, versionId: string): Promise<void>;
  /** Keep a valid branch of an Original that diverges from its committed log. */
  putBranch(did: string, log: string): Promise<void>;
  getBranches(did: string): Promise<string[]>;
  /** Keep a refused candidate (P6.8). Idempotent by its versionId. */
  /** Keep a refused candidate. Storing it again with the same entry updates its label; the entry itself never changes. */
  putRefused(did: string, refused: StoredRefused): Promise<void>;
  getRefused(did: string): Promise<StoredRefused[]>;
  /** Forget a refused candidate, when its signer abandons it. Reconciling never drops it (P6.8). */
  dropRefused(did: string, versionId: string): Promise<void>;
  list(): Promise<string[]>;
}

/** The versionId a stored refused candidate's entry names. */
export function refusedVersionId(refused: StoredRefused): string {
  const entry = parseJson(refused.entry) as { versionId?: unknown };
  return typeof entry.versionId === "string" ? entry.versionId : "";
}

/**
 * The higher of two retained versionIds, so a store never lowers one (P7.8). VH versionIds
 * compare by version number; ids without one (a did:btco version) are replaced as given.
 */
export function higherVersion(current: string | undefined, next: string): string {
  const n = (id: string) => Number(/^(\d+)-/.exec(id)?.[1] ?? NaN);
  return current !== undefined && n(current) > n(next) ? current : next;
}

/** The versionId of a log's last line, or null for an empty log. */
export function headOf(log: string | undefined): string | null {
  if (!log) return null;
  const lines = log.trimEnd().split("\n");
  const last = parseJson(lines[lines.length - 1]) as { versionId?: unknown };
  return typeof last.versionId === "string" ? last.versionId : null;
}

export function staleHead(did: string, expected: string | null, actual: string | null): OriginalsError {
  return new OriginalsError("stale-parent", "STALE_PARENT", `${did} is at ${actual ?? "nothing"}, not ${expected ?? "nothing"}`);
}

/** An in-memory store. Commits are atomic because they are synchronous. */
export class MemoryStore implements OriginalsStore {
  private readonly originals = new Map<string, StoredOriginal>();
  private readonly resources = new Map<string, Uint8Array>();
  private readonly authors = new Map<string, AuthorDidEvidence>();
  private readonly retained = new Map<string, string>();
  private readonly branches = new Map<string, string[]>();
  private readonly refused = new Map<string, StoredRefused[]>();

  get(did: string): Promise<StoredOriginal | undefined> {
    return Promise.resolve(this.originals.get(did));
  }

  commit(did: string, update: CommitUpdate): Promise<void> {
    const current = headOf(this.originals.get(did)?.log);
    if (current !== update.expectedHead) return Promise.reject(staleHead(did, update.expectedHead, current));
    this.originals.set(did, { log: update.log, ...(update.witness !== undefined ? { witness: update.witness } : {}) });
    return Promise.resolve();
  }

  putResource(digest: string, bytes: Uint8Array): Promise<void> {
    if (!this.resources.has(digest)) this.resources.set(digest, bytes.slice());
    return Promise.resolve();
  }

  getResource(digest: string): Promise<Uint8Array | undefined> {
    const bytes = this.resources.get(digest);
    return Promise.resolve(bytes?.slice());
  }

  putAuthorEvidence(evidence: AuthorDidEvidence): Promise<void> {
    this.authors.set(evidence.did, structuredClone(evidence));
    return Promise.resolve();
  }

  getAuthorEvidence(did: string): Promise<AuthorDidEvidence | undefined> {
    const evidence = this.authors.get(did);
    return Promise.resolve(evidence ? structuredClone(evidence) : undefined);
  }

  getRetained(did: string): Promise<string | undefined> {
    return Promise.resolve(this.retained.get(did));
  }

  putRetained(did: string, versionId: string): Promise<void> {
    this.retained.set(did, higherVersion(this.retained.get(did), versionId));
    return Promise.resolve();
  }

  putBranch(did: string, log: string): Promise<void> {
    const known = this.branches.get(did) ?? [];
    if (!known.includes(log)) this.branches.set(did, [...known, log]);
    return Promise.resolve();
  }

  getBranches(did: string): Promise<string[]> {
    return Promise.resolve([...(this.branches.get(did) ?? [])]);
  }

  putRefused(did: string, refused: StoredRefused): Promise<void> {
    const known = this.refused.get(did) ?? [];
    const id = refusedVersionId(refused);
    const at = known.findIndex((r) => refusedVersionId(r) === id);
    if (at < 0) this.refused.set(did, [...known, { ...refused }]);
    else if (known[at].entry === refused.entry) this.refused.set(did, known.map((r, k) => (k === at ? { ...refused } : r)));
    return Promise.resolve();
  }

  getRefused(did: string): Promise<StoredRefused[]> {
    return Promise.resolve((this.refused.get(did) ?? []).map((r) => ({ ...r })));
  }

  dropRefused(did: string, versionId: string): Promise<void> {
    this.refused.set(did, (this.refused.get(did) ?? []).filter((r) => refusedVersionId(r) !== versionId));
    return Promise.resolve();
  }

  /** Forget stored bytes, as a store that lost them would. */
  deleteResource(digest: string): void {
    this.resources.delete(digest);
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.originals.keys()]);
  }
}
