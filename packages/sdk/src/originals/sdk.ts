/**
 * The Originals SDK, local slice (plan 011, PR 4; spec sections 6 and 7).
 *
 * - Create prepares a genesis entry; without a signer it returns an explicit
 *   unsigned draft (P6.3).
 * - Edit and deactivate name their parent. A moved parent is a conflict, never
 *   a rebase (P4.5, P6.4).
 * - Commit signs, verifies the whole resulting history, stores new bytes and
 *   then replaces the log atomically (P6.1, P6.2). Retrying an accepted,
 *   identical candidate returns its checkpoint.
 * - Package, load and import work on evidence packages (section 7). Loading
 *   or importing never confers signing authority (P7.5, P8.4).
 * - Every verification compares against the highest versionIds this store has
 *   verified for the Original and its author DIDs, so an older prefix is stale
 *   rather than current (P7.6, P7.8). Reads, commits and imports retain the
 *   new highest; loading a package changes nothing.
 * - An import that diverges from the committed log keeps the other branch.
 *   From then on the Original reports the fork, with every branch, and is not
 *   current; edits continue on the local branch. Only anchoring settles a
 *   fork (P6.6, P9.16; owner decision Q5).
 */
import { OriginalsError } from "@originals/vh";
import { multibaseEncode } from "@originals/vh/crypto";
import { parseJson, type JsonObject } from "@originals/vh/json";
import { serializeLog, type LogEntry, type UnsignedEntry } from "@originals/vh/log";
import {
  prepareCreateOriginal,
  prepareDeactivateOriginal,
  prepareUpdateOriginal,
  resourceDigest,
  verifyAuthorHistory,
  verifyOriginal,
  type AssetState,
  type AuthorDidEvidence,
  type AuthorRef,
  type EntryState,
  type OriginalsReport,
  type ResourceDescriptor,
  type ResourceVersion,
  type RetainedVersions,
  type VerifyOriginalOptions,
} from "@originals/vh/originals";
import { readEvidence, writeEvidence, type EvidenceManifest, type MissingItem } from "./evidence.js";
import { summarize, type EntrySummary, type OriginalsSigner } from "./signer.js";
import { MemoryStore, headOf, staleHead, type OriginalsStore } from "./store.js";
import type { ZipLimits } from "./zip.js";

export type AuthorSource = AuthorDidEvidence[] | ((did: string) => Promise<AuthorDidEvidence | undefined>);

export interface OriginalsSDKOptions {
  store?: OriginalsStore;
  /** Where author DID histories come from. */
  authors: AuthorSource;
  /**
   * `asserted` when the caller vouches that the evidence it supplies is the
   * latest, as an author's own SDK can (P7.8). Reports say so.
   */
  freshness?: "asserted";
  /** Milliseconds since the epoch; used for entry timestamps and verification time. */
  clock?: () => number;
  archiveLimits?: ZipLimits;
}

export interface ResourceInput {
  id: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ResourceChange {
  id: string;
  bytes: Uint8Array;
  /** Defaults to the current media type. */
  mediaType?: string;
  /** The digest the caller edited from; a different current digest is a conflict (P4.5). */
  expectedDigest?: string;
}

export interface CreateInput {
  name: string;
  metadata?: JsonObject;
  resources: ResourceInput[];
  author: AuthorRef;
}

export interface EditInput {
  /** The checkpoint this edit builds on. */
  parent: string;
  name?: string;
  metadata?: JsonObject | null;
  resources?: ResourceChange[];
  author: AuthorRef;
}

export interface Draft {
  readonly kind: "draft";
  readonly signed: false;
  /** The Original's did:vh. */
  readonly original: string;
  /** The checkpoint the draft builds on, or null for a create. */
  readonly parent: string | null;
  /** The unsigned entry; preparing again makes a new candidate (P4.5). */
  readonly entry: UnsignedEntry;
  readonly summary: EntrySummary;
  /** New resource bytes by digest. */
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

export interface OriginalView {
  did: string;
  checkpoint: string;
  head: string;
  state: AssetState;
  resources: ResourceVersion[];
  current: boolean;
  report: OriginalsReport;
}

export interface CommitResult {
  status: "committed" | "duplicate";
  original: OriginalView;
}

export interface EvidencePackage {
  bytes: Uint8Array;
  manifest: EvidenceManifest;
}

export interface LoadedEvidence {
  manifest: EvidenceManifest;
  report: OriginalsReport;
  reasons: string[];
}

export interface ImportResult {
  status: "imported" | "already-current" | "kept-newer-local" | "conflict";
  original: OriginalView;
}

function sdkError(category: ConstructorParameters<typeof OriginalsError>[0], code: string, message: string, details?: Record<string, unknown>): never {
  throw new OriginalsError(category, code, message, details);
}

function exactKeys(value: object, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) sdkError("invalid-evidence", "INPUT_INVALID", `${where} has an unknown field ${key}`);
  }
}

function lines(log: string): string[] {
  return log.length === 0 ? [] : log.trimEnd().split("\n");
}

function versionIds(log: string): string[] {
  return lines(log).map((line) => (parseJson(line) as { versionId: string }).versionId);
}

function authorDidsOf(log: string): string[] {
  const dids = new Set<string>();
  for (const line of lines(log)) {
    try {
      const entry = JSON.parse(line) as { state?: { author?: { did?: unknown } } };
      if (typeof entry.state?.author?.did === "string") dids.add(entry.state.author.did);
    } catch {
      // Verification reports the malformed line.
    }
  }
  return [...dids];
}

/** The did:vh a log's genesis names, before verification; only used to look up what to compare with. */
function originalOf(log: string): string | undefined {
  try {
    const first = JSON.parse(lines(log)[0] ?? "null") as { state?: { id?: unknown } } | null;
    return typeof first?.state?.id === "string" ? first.state.id : undefined;
  } catch {
    return undefined;
  }
}

function digestsOf(log: string): string[] {
  const digests = new Set<string>();
  for (const line of lines(log)) {
    try {
      const entry = JSON.parse(line) as { state?: { asset?: { resources?: Array<{ digest?: unknown }> } } };
      for (const r of entry.state?.asset?.resources ?? []) if (typeof r.digest === "string") digests.add(r.digest);
    } catch {
      // As above.
    }
  }
  return [...digests];
}

export class OriginalsSDK {
  private readonly store: OriginalsStore;
  private readonly clock: () => number;

  private constructor(private readonly options: OriginalsSDKOptions) {
    this.store = options.store ?? new MemoryStore();
    this.clock = options.clock ?? (() => Date.now());
  }

  static create(options: OriginalsSDKOptions): OriginalsSDK {
    return new OriginalsSDK(options);
  }

  // ---------------------------------------------------------------- reading

  private async authorEvidence(dids: string[], supplied: AuthorDidEvidence[] = []): Promise<AuthorDidEvidence[]> {
    const out: AuthorDidEvidence[] = [];
    for (const did of dids) {
      const own = supplied.find((a) => a.did === did);
      const source = this.options.authors;
      const found = own ?? (Array.isArray(source) ? source.find((a) => a.did === did) : await source(did)) ?? (await this.store.getAuthorEvidence(did));
      if (found) out.push(found);
    }
    return out;
  }

  private async storedBytes(log: string, extra?: ReadonlyMap<string, Uint8Array>): Promise<Record<string, Uint8Array>> {
    const out: Record<string, Uint8Array> = {};
    for (const digest of digestsOf(log)) {
      const bytes = extra?.get(digest) ?? (await this.store.getResource(digest));
      if (bytes) out[digest] = bytes;
    }
    return out;
  }

  /** What this store retains about a log's Original and author DIDs: retained versionIds and known branches (P7.8). */
  private async comparisons(log: string): Promise<Pick<VerifyOriginalOptions, "retained" | "copies">> {
    // The genesis id is unverified here: a malformed one simply has nothing to compare with.
    const quietly = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof OriginalsError) return fallback;
        throw error;
      }
    };
    const did = originalOf(log);
    const retained: RetainedVersions = { authors: {} };
    const original = did ? await quietly(() => this.store.getRetained(did), undefined) : undefined;
    if (original) retained.original = original;
    for (const author of authorDidsOf(log)) {
      const version = await quietly(() => this.store.getRetained(author), undefined);
      if (version) retained.authors![author] = version;
    }
    const branches = did ? await quietly(() => this.store.getBranches(did), []) : [];
    const copies = branches.map((branch, i) => ({ source: `branch-${i + 1}`, log: branch }));
    // A log that is not this store's committed one is also compared with the committed log, so
    // a shorter log that diverges from local history is a fork, not merely stale (P6.6, P7.8).
    const committed = did ? (await quietly(() => this.store.get(did), undefined))?.log : undefined;
    if (committed !== undefined && committed !== log) copies.unshift({ source: "local", log: committed });
    return { retained, copies };
  }

  /** Keep the highest versionIds a report verified. The report never lowers them. */
  private async retain(report: OriginalsReport): Promise<void> {
    if (report.original && report.retain.original) await this.store.putRetained(report.original, report.retain.original);
    for (const [did, versionId] of Object.entries(report.retain.authors)) await this.store.putRetained(did, versionId);
  }

  private async verify(log: string, checkpoint?: string, extra?: ReadonlyMap<string, Uint8Array>): Promise<OriginalsReport> {
    return verifyOriginal({
      log,
      authors: await this.authorEvidence(authorDidsOf(log)),
      bytes: await this.storedBytes(log, extra),
      now: this.clock(),
      ...(await this.comparisons(log)),
      ...(checkpoint ? { checkpoint } : {}),
      ...(this.options.freshness ? { freshness: this.options.freshness } : {}),
    });
  }

  private view(did: string, report: OriginalsReport): OriginalView {
    if (!report.checkpoint || !report.state || !report.head) {
      const failure = report.history.failure;
      sdkError(failure?.category ?? "incomplete-evidence", "ORIGINAL_NOT_VERIFIED", `${did} has no verified checkpoint: ${failure?.message ?? report.reasons.join(", ")}`, { report });
    }
    return { did, checkpoint: report.checkpoint, head: report.head, state: report.state, resources: report.resources.versions, current: report.current, report };
  }

  private async stored(did: string): Promise<string> {
    const stored = await this.store.get(did);
    if (!stored) sdkError("incomplete-evidence", "ORIGINAL_NOT_FOUND", `${did} is not in this store`);
    return stored.log;
  }

  /** The verified state of a stored Original, at its head or an exact checkpoint (P3.2). */
  async get(did: string, options: { checkpoint?: string } = {}): Promise<OriginalView> {
    const log = await this.stored(did);
    const report = await this.verify(log, options.checkpoint);
    await this.retain(report);
    if (options.checkpoint && report.checkpoint !== options.checkpoint) {
      sdkError("incomplete-evidence", "CHECKPOINT_NOT_FOUND", `${options.checkpoint} is not a verified checkpoint of ${did}`, { report });
    }
    return this.view(did, report);
  }

  // ---------------------------------------------------------------- preparing

  private versionTime(previous?: string): string {
    const after = previous ? Date.parse(previous) + 1 : -Infinity;
    return new Date(Math.max(this.clock(), after)).toISOString();
  }

  async prepareCreate(input: CreateInput): Promise<Draft> {
    exactKeys(input, ["name", "metadata", "resources", "author", "signer"], "create input");
    const bytes = new Map<string, Uint8Array>();
    const resources: ResourceDescriptor[] = input.resources.map((r, i) => {
      exactKeys(r, ["id", "mediaType", "bytes"], `resources[${i}]`);
      if (!(r.bytes instanceof Uint8Array)) sdkError("invalid-evidence", "INPUT_INVALID", `resources[${i}].bytes must be a Uint8Array`);
      const digest = resourceDigest(r.bytes);
      bytes.set(digest, r.bytes.slice());
      return { id: r.id, mediaType: r.mediaType, size: r.bytes.length, digest };
    });
    const entry = prepareCreateOriginal({
      versionTime: this.versionTime(), name: input.name, ...(input.metadata !== undefined ? { metadata: input.metadata } : {}), resources, author: input.author,
    });
    return Promise.resolve({ kind: "draft", signed: false, original: entry.state.id as string, parent: null, entry, summary: summarize(entry), bytes });
  }

  /** Create an Original, or return an unsigned draft when no signer is given. */
  async create(input: CreateInput & { signer?: OriginalsSigner }): Promise<{ kind: "draft"; draft: Draft } | { kind: "original"; original: OriginalView }> {
    const draft = await this.prepareCreate(input);
    if (!input.signer) return { kind: "draft", draft };
    return { kind: "original", original: (await this.commit(draft, input.signer)).original };
  }

  private async parentOf(did: string, parent: string): Promise<{ log: string; head: LogEntry; view: OriginalView }> {
    const log = await this.stored(did);
    const view = this.view(did, await this.verify(log));
    if (view.report.history.status !== "valid" || view.report.identityEvidence.status !== "complete") {
      sdkError("incomplete-evidence", "PARENT_NOT_VERIFIED", `${did} does not fully verify; it cannot be extended`, { report: view.report });
    }
    if (view.report.deactivated) sdkError("deactivated", "ORIGINAL_DEACTIVATED", `${did} is deactivated`);
    if (view.checkpoint !== parent) throw staleHead(did, parent, view.checkpoint);
    const all = lines(log);
    return { log, head: parseJson(all[all.length - 1]) as unknown as LogEntry, view };
  }

  async prepareEdit(did: string, input: EditInput): Promise<Draft> {
    exactKeys(input, ["parent", "name", "metadata", "resources", "author", "signer"], "edit input");
    const { head, view } = await this.parentOf(did, input.parent);
    const bytes = new Map<string, Uint8Array>();
    const resources = (input.resources ?? []).map((r, i) => {
      exactKeys(r, ["id", "bytes", "mediaType", "expectedDigest"], `resources[${i}]`);
      const current = view.state.resources.find((c) => c.id === r.id);
      if (r.expectedDigest !== undefined && current?.digest !== r.expectedDigest) {
        sdkError("stale-parent", "STALE_DIGEST", `resource ${r.id} is at ${current?.digest ?? "nothing"}, not ${r.expectedDigest}`);
      }
      const digest = resourceDigest(r.bytes);
      bytes.set(digest, r.bytes.slice());
      return { id: r.id, mediaType: r.mediaType ?? current?.mediaType ?? "", size: r.bytes.length, digest };
    });
    const entry = prepareUpdateOriginal(head, {
      versionTime: this.versionTime(head.versionTime),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      resources,
      author: input.author,
    });
    return { kind: "draft", signed: false, original: did, parent: input.parent, entry, summary: summarize(entry, head.state as unknown as EntryState), bytes };
  }

  async edit(did: string, input: EditInput & { signer: OriginalsSigner }): Promise<CommitResult> {
    return this.commit(await this.prepareEdit(did, input), input.signer);
  }

  async prepareDeactivate(did: string, input: { parent: string; author: AuthorRef }): Promise<Draft> {
    const { head } = await this.parentOf(did, input.parent);
    const entry = prepareDeactivateOriginal(head, { versionTime: this.versionTime(head.versionTime), author: input.author });
    return { kind: "draft", signed: false, original: did, parent: input.parent, entry, summary: summarize(entry, head.state as unknown as EntryState), bytes: new Map() };
  }

  async deactivate(did: string, input: { parent: string; author: AuthorRef; signer: OriginalsSigner }): Promise<CommitResult> {
    return this.commit(await this.prepareDeactivate(did, input), input.signer);
  }

  // ---------------------------------------------------------------- committing

  /** Sign, verify and durably commit a draft (P6.1, P6.2, P6.4). */
  async commit(draft: Draft, signer: OriginalsSigner): Promise<CommitResult> {
    const stored = (await this.store.get(draft.original))?.log ?? "";
    if (versionIds(stored).includes(draft.entry.versionId)) {
      return { status: "duplicate", original: await this.get(draft.original) };
    }
    const head = headOf(stored);
    if (head !== draft.parent) throw staleHead(draft.original, draft.parent, head);

    const proofOptions = { type: "DataIntegrityProof" as const, cryptosuite: signer.cryptosuite, verificationMethod: signer.verificationMethod, proofPurpose: "assertionMethod" };
    const signature = await signer.sign({ entry: draft.entry, proofOptions, summary: draft.summary });
    const entry: LogEntry = { ...draft.entry, proof: [{ ...proofOptions, proofValue: multibaseEncode(signature) }] };
    const candidate = stored + serializeLog([entry]);

    const report = await this.verify(candidate, undefined, draft.bytes);
    const added = report.resources.versions.filter((v) => v.versionId === entry.versionId);
    if (
      report.history.status !== "valid" || report.history.entries !== lines(candidate).length ||
      report.authorBinding.status !== "valid" || report.identityEvidence.status !== "complete" ||
      added.some((v) => v.bytes !== "verified")
    ) {
      sdkError("invalid-evidence", "COMMIT_VERIFICATION_FAILED", `the signed entry does not verify: ${report.history.failure?.message ?? report.reasons.join(", ")}`, { report });
    }
    for (const [digest, bytes] of draft.bytes) await this.store.putResource(digest, bytes);
    await this.store.commit(draft.original, { expectedHead: head, log: candidate });
    await this.retain(report);
    return { status: "committed", original: this.view(draft.original, report) };
  }

  // ---------------------------------------------------------------- evidence

  /** An evidence package for the head or an exact checkpoint (P7.1). */
  async package(did: string, options: { checkpoint?: string } = {}): Promise<EvidencePackage> {
    const log = await this.stored(did);
    const view = await this.get(did, options);
    const ids = versionIds(log);
    const prefix = `${lines(log).slice(0, ids.indexOf(view.checkpoint) + 1).join("\n")}\n`;
    const authors = await this.authorEvidence(authorDidsOf(prefix));
    const missing: MissingItem[] = [];
    for (const did of authorDidsOf(prefix)) if (!authors.some((a) => a.did === did)) missing.push({ kind: "identity", did });
    const bytes: Record<string, Uint8Array> = {};
    for (const v of view.report.resources.versions) {
      const data = await this.store.getResource(v.digest);
      if (data && resourceDigest(data) === v.digest) bytes[v.digest] = data;
      else missing.push({ kind: "resource", resource: v.resource, version: v.version, digest: v.digest, versionId: v.versionId });
    }
    const manifest: EvidenceManifest = {
      format: "originals-evidence/0.1",
      profile: "originals:1.0",
      original: did,
      checkpoint: view.checkpoint,
      head: ids[ids.length - 1],
      completeness: missing.length === 0 && view.report.identityEvidence.status === "complete" ? "complete" : "partial",
      missing,
    };
    return { bytes: writeEvidence({ manifest, log: prefix, authors, bytes }), manifest };
  }

  /** Verify an evidence package without storing it. Needs no key and no network (P7.3). */
  async load(zip: Uint8Array): Promise<LoadedEvidence> {
    const contents = readEvidence(zip, this.options.archiveLimits);
    const report = await verifyOriginal({
      log: contents.log,
      authors: await this.authorEvidence(authorDidsOf(contents.log), contents.authors),
      bytes: contents.bytes,
      witnessFile: contents.witness,
      checkpoint: contents.manifest.checkpoint,
      now: this.clock(),
      ...(await this.comparisons(contents.log)),
      ...(this.options.freshness ? { freshness: this.options.freshness } : {}),
    });
    const reasons = [...report.reasons];
    const m = contents.manifest;
    if (m.original !== report.original) reasons.push("manifest-original-mismatch");
    if (m.checkpoint !== m.head) reasons.push("package-checkpoint-is-not-its-head");
    const actuallyComplete = report.resources.missing.length === 0 && report.identityEvidence.status === "complete";
    if ((m.completeness === "complete") !== actuallyComplete) reasons.push("manifest-completeness-mismatch");
    return { manifest: m, report: { ...report, current: report.current && reasons.length === report.reasons.length }, reasons };
  }

  /**
   * Verify a package and store it, unless that would roll back or replace
   * local history (P7.5). A diverging branch is kept beside the local one and
   * reported as a fork. Author evidence is stored only when it is at least as
   * new as what this store has verified (P7.8).
   */
  async import(zip: Uint8Array): Promise<ImportResult> {
    const contents = readEvidence(zip, this.options.archiveLimits);
    const loaded = await this.load(zip);
    const r = loaded.report;
    if (!r.original || r.history.status !== "valid" || r.authorBinding.status !== "valid" || r.identityEvidence.status !== "complete") {
      sdkError("invalid-evidence", "IMPORT_REJECTED", "the package does not verify", { report: r });
    }
    // The verified head must be the package's own last entry: nothing else may be stored (P7.5).
    const own = versionIds(contents.log);
    if (r.head !== own[own.length - 1]) {
      sdkError("invalid-evidence", "IMPORT_REJECTED", "the package's log does not verify to its last entry", { report: r });
    }
    const did = r.original;
    const incoming = versionIds(contents.log);
    const local = (await this.store.get(did))?.log;
    const result = async (status: ImportResult["status"]): Promise<ImportResult> => ({ status, original: await this.get(did) });
    if (local) {
      const have = versionIds(local);
      const sharesPrefix = (a: string[], b: string[]) => a.every((id, i) => b[i] === id);
      if (have.length === incoming.length && sharesPrefix(incoming, have)) return result("already-current");
      if (incoming.length < have.length && sharesPrefix(incoming, have)) return result("kept-newer-local");
      if (!sharesPrefix(have, incoming)) {
        await this.keepEvidence(contents, r);
        await this.store.putBranch(did, contents.log);
        return result("conflict");
      }
    }
    await this.keepEvidence(contents, r);
    await this.store.commit(did, { expectedHead: headOf(local), log: contents.log });
    return result("imported");
  }

  private async keepEvidence(contents: ReturnType<typeof readEvidence>, report: OriginalsReport): Promise<void> {
    for (const [digest, bytes] of Object.entries(contents.bytes)) {
      if (resourceDigest(bytes) === digest) await this.store.putResource(digest, bytes);
    }
    for (const evidence of contents.authors) {
      const history = await verifyAuthorHistory(evidence, { now: this.clock() });
      const latest = history.versions[history.versions.length - 1]?.versionId;
      if (latest !== undefined && report.retain.authors[evidence.did] === latest) await this.store.putAuthorEvidence(evidence);
    }
  }
}

