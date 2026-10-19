/**
 * The durable local commit contract (P6.2). An Original's committed history is
 * its log; the SDK stores new resource bytes first and then replaces the log
 * in one atomic step, conditional on the head it built on. An interrupted
 * commit therefore leaves the prior log or the new one, never a checkpoint
 * whose bytes were not stored. Staged bytes may remain; they are content
 * addressed and are never a committed version on their own (P6.1).
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

export interface OriginalsStore {
  get(did: string): Promise<StoredOriginal | undefined>;
  /** Atomically replace the log if the stored head is `expectedHead`; otherwise a stale-parent conflict. */
  commit(did: string, update: CommitUpdate): Promise<void>;
  putResource(digest: string, bytes: Uint8Array): Promise<void>;
  getResource(digest: string): Promise<Uint8Array | undefined>;
  /** Keep author DID evidence that arrived with imported Originals. Verified on every read. */
  putAuthorEvidence(evidence: AuthorDidEvidence): Promise<void>;
  getAuthorEvidence(did: string): Promise<AuthorDidEvidence | undefined>;
  list(): Promise<string[]>;
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

  /** Forget stored bytes, as a store that lost them would. */
  deleteResource(digest: string): void {
    this.resources.delete(digest);
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.originals.keys()]);
  }
}
