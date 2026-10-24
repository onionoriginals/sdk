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
 *   (P7.6, P7.8). Reads, commits and imports retain the new highest; loading a
 *   package changes nothing.
 * - An unanchored Original is never current (P7.10): a valid one is reported
 *   valid as of its verified checkpoint (`validAsOf`), naming the signer DID
 *   versions relied on and when each history was obtained. Evidence is stamped
 *   with when and where the SDK obtained it: `package`, `host` (a hosted
 *   snapshot), `fetched` (`identityFetch`), `retained` (this store), or
 *   `supplied` (the `authors` option, with the caller's own `obtainedAt`).
 * - Publication (P3.6): `publish` lists a did:webvh alias that already points
 *   back to the Original. `loadPublished` is the public reader: it retrieves
 *   the hosted snapshot through the alias and verifies that exact checkpoint
 *   (P9.1). There are no witnesses (owner decision Q14).
 * - An import that diverges from the committed log keeps the other branch.
 *   From then on the Original reports the fork, with every branch, and is not
 *   current; edits continue on the local branch. Only anchoring settles a
 *   fork (P6.6, P9.16; owner decision Q5).
 * - Shared-host saves (P6.7, P6.8; ./shared.ts): `sign` makes a verified
 *   candidate against the exact local parent without committing it;
 *   `submit` sends it to the host and commits it locally only once the host
 *   accepts it. A stale-parent refusal keeps the draft and the signed
 *   candidate, labelled `refused`, beside the log and never in it, and the
 *   SDK never commits, packages, publishes or submits it again. `reconcile`
 *   fetches and verifies the host's new head and has the caller's signer sign
 *   the caller's reconciled change against it; the SDK never merges or signs
 *   on its own.
 */
import { OriginalsError } from "@originals/vh";
import { multibaseEncode } from "@originals/vh/crypto";
import { isJsonObject, parseJson, type JsonObject } from "@originals/vh/json";
import { serializeLog, vhHash, type LogEntry, type UnsignedEntry } from "@originals/vh/log";
import {
  prepareCreateOriginal,
  prepareDeactivateOriginal,
  prepareUpdateOriginal,
  checkAlias,
  resourceDigest,
  signerLocation,
  verifyAuthorHistory,
  verifyOriginal,
  parseBtcoAlias,
  ORIGINALS_INSCRIPTION_MAX_BYTES,
  type AliasEvidence,
  type AliasReport,
  type AssetState,
  type AuthorDidEvidence,
  type AuthorRef,
  type EditorGrant,
  type EditorRef,
  type EntryState,
  type OriginalsReport,
  type ResourceDescriptor,
  type ResourceVersion,
  type RetainedVersions,
  type SatEvidence,
  type ValidAsOf,
  type VerifyOriginalOptions,
} from "@originals/vh/originals";
import { didWebvhFilesUrl, didWebvhLogUrl, parseDidWebvh } from "@originals/vh/webvh";
import { MANIFEST, signerPath, readEvidence, readEvidenceFiles, readManifest, writeEvidence, type EvidenceContents, type EvidenceManifest, type MissingItem } from "./evidence.js";
import { HOSTED_PREFIX, assertHostable, type HostedFetch, type RetrievalLimits } from "./hosting.js";
import { Retrieval, retrievalPlan } from "./retrieval.js";
import { describeEntry, summarize, type EntrySummary, type OriginalsSigner } from "./signer.js";
import type { HostAnswer, SharedHost } from "./shared.js";
import { MemoryStore, headOf, higherVersion, refusedVersionId, staleHead, type OriginalsStore, type StoredRefused } from "./store.js";
import type { ZipLimits } from "./zip.js";

export type AuthorSource = AuthorDidEvidence[] | ((did: string) => Promise<AuthorDidEvidence | undefined>);

export interface OriginalsSDKOptions {
  store?: OriginalsStore;
  /**
   * Where author DID histories come from. Give each its `obtainedAt` (ISO
   * 8601): reports on unanchored Originals state when the evidence they relied
   * on was obtained (P7.10), and say null when it was not given.
   */
  authors: AuthorSource;
  /** Milliseconds since the epoch; used for entry timestamps and verification time. */
  clock?: () => number;
  /** Bounds on one evidence package: `load`, `import`, and the snapshot `loadPublished` retrieves. */
  archiveLimits?: ZipLimits;
  /**
   * Whole-operation bounds on `loadPublished` (PROVISIONAL; `RETRIEVAL_LIMITS`).
   * Its byte budget defaults to `archiveLimits.maxTotalBytes`.
   */
  retrievalLimits?: RetrievalLimits;
  /**
   * Retrieve a did:webvh signer identity's log where P5.14 says to find it:
   * at the location of the DID in the verification method id of the latest
   * entry that identity signed. Redirects must not be followed (P8.5);
   * `safeFetch` fits: `async (url, o) => (await safeFetch(url, o)).bytes`.
   * A log retrieved there that verifies from the identity DID's genesis, and
   * extends any other evidence for it, is used, and the report states its URL,
   * when it was retrieved and its latest versionId. Its freshness is
   * established only when the DID's own witnesses approve that version and
   * the version's `id` names the location (P7.8; owner decision, 23 Oct
   * 2026; originals-spec #51, merged); otherwise, or if it cannot be obtained, it is not established.
   *
   * Bounded (08b review R1, R2, A4): only the author DID fixed at genesis is
   * an identity to retrieve, and its location is read from the log's
   * VH-chained entries. At most two requests (log and witness file) per
   * identity are made. In `loadPublished` they are planned and counted in the
   * call's retrieval budget, deadline and signal; every other operation gives
   * them a budget of its own from `retrievalLimits`, and an identity not
   * retrieved within it keeps its freshness not established. Without this
   * option nothing is ever requested.
   */
  identityFetch?: HostedFetch;
}

export interface ResourceInput {
  id: string;
  mediaType: string;
  bytes: Uint8Array;
}

/**
 * New bytes for a resource. An id in the parent's resource set changes that
 * resource; a new id adds a resource, appended after the existing ones in the
 * order given, at version 1 (P4.1, P4.4). Only the author adds (P5.16), and a
 * resourceID the Original has used before, even for a removed resource, is
 * refused (P4.1).
 */
export interface ResourceChange {
  id: string;
  bytes: Uint8Array;
  /** Defaults to the current media type; required for an added resource. */
  mediaType?: string;
  /** The digest the caller edited from; a different current digest is a conflict (P4.5). Not for an added resource. */
  expectedDigest?: string;
}

export interface CreateInput {
  name: string;
  metadata?: JsonObject;
  resources: ResourceInput[];
  author: AuthorRef;
  /** Editor grants (P5.15; PROVISIONAL member names, D4). */
  editors?: EditorGrant[];
}

export interface EditInput {
  /** The checkpoint this edit builds on. */
  parent: string;
  name?: string;
  metadata?: JsonObject | null;
  resources?: ResourceChange[];
  /**
   * ResourceIDs to remove (P4.1). Author only (P5.16). At least one resource
   * must remain, and a removed resource must also leave every grant: pass
   * `editors` without it. Its earlier versions stay in history, packages and
   * hosted retrieval (P8.3).
   */
  remove?: string[];
  /** The author reference: required for an author's edit; an editor's edit carries its parent's (P5.16). */
  author?: AuthorRef;
  /**
   * Edit as a granted editor (P5.16): the editor DID, its verification method
   * and exact versionId. The signer is the editor's key. The grant in the
   * parent's state must cover every change, or nothing is signed.
   */
  editor?: EditorRef;
  /** Replace the editor grants; null removes them all (P5.15, P5.17). Author only. */
  editors?: EditorGrant[] | null;
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
  /** What the signer is shown (P5.11): `describeEntry(summary)`. */
  readonly display: string;
  /** New resource bytes by digest. */
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

/** A signed entry verified against its exact parent, not yet history (P6.1). */
export interface SignedCandidate {
  readonly kind: "candidate";
  readonly original: string;
  /** The checkpoint it extends; null for a genesis entry. */
  readonly parent: string | null;
  readonly versionId: string;
  readonly entry: LogEntry;
  /** The entry as one JSON line, no newline: the exact bytes a host stores and compares (P6.7). */
  readonly line: string;
  readonly summary: EntrySummary;
  /** New resource bytes by digest. */
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

/**
 * A candidate a shared host refused with a stale-parent conflict (P6.8). It is
 * a valid entry with the same parent as an accepted one, so it is kept for the
 * signer's intended change and is never history: the SDK never commits,
 * packages, publishes, submits or inscribes it.
 */
export interface RefusedCandidate {
  readonly label: "refused";
  readonly original: string;
  readonly parent: string;
  readonly versionId: string;
  /** The refused signed entry, exactly as submitted. */
  readonly entry: LogEntry;
  /** The draft it was signed from: the same entry without its proof, with its new bytes. */
  readonly draft: Draft;
  /** The host's head when it refused. */
  readonly hostHead: string;
  /** The accepted candidate that carried its change, once reconciled. */
  readonly reconciledAs?: string;
}

export type SubmitResult =
  | {
      status: "accepted" | "already-accepted";
      /** The candidate's checkpoint, now committed locally. */
      checkpoint: string;
      /** The host's current head. */
      hostHead: string;
      /** True when the host's head is past this checkpoint; `sync` fetches it. */
      behind: boolean;
      original: OriginalView;
    }
  | { status: "stale-parent"; hostHead: string; refused: RefusedCandidate };

/** The content a reconciled candidate changes; its parent is always the host's new head. */
export type ReconciledChange = Pick<EditInput, "name" | "metadata" | "resources" | "remove">;

export interface ReconcileInput {
  host: SharedHost;
  /** The refused candidate this reconciles, if any; it is forgotten once the reconciled one is accepted. */
  refused?: string;
  author: AuthorRef;
  /** An authorized signer: the SDK never signs on anyone's behalf (P6.8). */
  signer: OriginalsSigner;
  /**
   * The reconciled change, or a function that returns it from the new head
   * and the refused candidate. Required: the SDK never merges (P6.8).
   */
  change: ReconciledChange | ((context: { head: OriginalView; refused?: RefusedCandidate }) => ReconciledChange | Promise<ReconciledChange>);
}

export interface OriginalView {
  did: string;
  checkpoint: string;
  head: string;
  state: AssetState;
  resources: ResourceVersion[];
  /** Never true for an unanchored Original (P7.10). */
  current: boolean;
  /**
   * P7.10: the checkpoint this result is valid as of, the signer DID versions
   * it relied on and when each history was obtained, for an anchored Original
   * as for an unanchored one; null when it does not verify (see
   * `report.reasons`). Entries that are historically authorized
   * only are in `report.historicallyAuthorizedOnly` (P7.9).
   */
  validAsOf: ValidAsOf | null;
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

export interface PublishedOriginal extends LoadedEvidence {
  alias: AliasReport;
  /**
   * The exact hosted snapshot verifies: valid history ending at the manifest's
   * checkpoint, author binding, complete identity evidence, no served bytes
   * that fail their digest, and the alias in both directions (P9.1, P3.6).
   * Missing bytes do not fail it: they are unavailable content, reported in
   * `report.resources` (P7.3, P7.4, P9.18); an application that needs the
   * content checks that too. It is never the latest state of an unanchored
   * Original: that is valid only as of the snapshot's checkpoint
   * (`report.validAsOf`, P7.10).
   */
  verified: boolean;
}

export interface ImportResult {
  status: "imported" | "already-current" | "kept-newer-local" | "conflict";
  original: OriginalView;
}

/** One candidate for a signer DID's evidence, with the versionIds of its log that verify (P7.8). */
interface HeldEvidence {
  evidence: AuthorDidEvidence;
  ids: string[] | undefined;
  complete: boolean;
}

/** True when `a`'s verified versionIds are `b`'s, then possibly more. */
function extendsIds(a: string[], b: string[]): boolean {
  return a.length >= b.length && b.every((id, i) => a[i] === id);
}

/**
 * The evidence to verify with, of `candidates` (most preferred first), compared
 * by the versionIds that verify, never by their bytes: the one with the newest
 * verified version is used (P7.8, P7.9; originals-spec #47,
 * merged). Two whose verified versions diverge are an identity fork: the
 * first is used, and `fork` names the other's versionId where they diverge,
 * which the verifier reports as AUTHOR_DID_FORK, incomplete identity evidence
 * (P7.8). `newest` is the newest verified versionId known, so a log that falls
 * short of it is stale.
 */
function newestEvidence(candidates: HeldEvidence[]): { chosen: AuthorDidEvidence; newest?: string; fork?: string } | undefined {
  const [first, ...rest] = candidates;
  if (!first) return undefined;
  let best = first;
  let fork: string | undefined;
  for (const c of rest) {
    if (!c.ids || !best.ids) {
      if (!best.ids && c.ids) best = c;
      continue;
    }
    if (extendsIds(c.ids, best.ids)) {
      if (c.ids.length > best.ids.length || (!best.complete && c.complete)) best = c;
    } else if (!extendsIds(best.ids, c.ids)) {
      const at = c.ids.findIndex((id, i) => best.ids![i] !== id);
      fork ??= c.ids[at];
    }
  }
  const verified = candidates.flatMap((c) => (c.ids && c.ids.length > 0 ? [c.ids] : []));
  const longest = verified.reduce<string[] | undefined>((a, b) => (!a || b.length > a.length ? b : a), undefined);
  return { chosen: best.evidence, ...(longest ? { newest: longest[longest.length - 1] } : {}), ...(fork ? { fork } : {}) };
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

/** The signer identity DIDs a log names: its author and each editor of an editor entry (P7.1), before verification. */
function signerDidsOf(log: string): string[] {
  const dids = new Set<string>();
  for (const line of lines(log)) {
    try {
      const entry = JSON.parse(line) as { state?: { author?: { did?: unknown }; editor?: { did?: unknown } } };
      if (typeof entry.state?.author?.did === "string") dids.add(entry.state.author.did);
      if (typeof entry.state?.editor?.did === "string") dids.add(entry.state.editor.did);
    } catch {
      // Verification reports the malformed line.
    }
  }
  return [...dids];
}

type ChainedEntry = JsonObject & { versionId: string };

/**
 * The parsed entries of the log's VH-chained prefix: each versionId is the
 * hash of its entry over its predecessor's versionId (the SCID for the
 * first), as VH-Log chains them. Checking this needs no key, so it can be
 * done before identity evidence is retrieved; it stops at the first line
 * that does not chain.
 */
function chainedEntries(log: string): ChainedEntry[] {
  const out: ChainedEntry[] = [];
  let predecessor: unknown;
  for (const [i, line] of lines(log).entries()) {
    try {
      const entry = parseJson(line);
      if (!isJsonObject(entry) || typeof entry.versionId !== "string") break;
      const id = /^(\d+)-(.+)$/.exec(entry.versionId);
      if (!id || Number(id[1]) !== i + 1) break;
      if (i === 0) predecessor = isJsonObject(entry.parameters) ? entry.parameters.scid : undefined;
      if (typeof predecessor !== "string") break;
      const { proof: _proof, ...unsigned } = entry;
      if (vhHash({ ...unsigned, versionId: predecessor }) !== id[2]) break;
      out.push(entry as ChainedEntry);
      predecessor = entry.versionId;
    } catch {
      break;
    }
  }
  return out;
}

/**
 * The signer identities whose logs `identityFetch` may retrieve (P5.14): the
 * author DID fixed at genesis (P5.8), and each editor DID a grant names in
 * the state of one of the first `verified` entries (P5.15), which the
 * verifier has checked. No other DID a line names is an identity of the
 * Original, so none is requested.
 */
function retrievableIdentities(chained: ChainedEntry[], verified: number): string[] {
  const out = new Set<string>();
  const author = isJsonObject(chained[0]?.state) && isJsonObject(chained[0].state.author) ? chained[0].state.author.did : undefined;
  if (typeof author === "string") out.add(author);
  for (const entry of chained.slice(0, verified)) {
    const asset = isJsonObject(entry.state) ? entry.state.asset : undefined;
    const editors = isJsonObject(asset) && Array.isArray(asset.editors) ? asset.editors : [];
    for (const grant of editors) if (isJsonObject(grant) && typeof grant.did === "string") out.add(grant.did);
  }
  return [...out];
}

/**
 * Where to retrieve `did`'s log (P5.14), in the order to try: the DID in the
 * verification method id of the latest entry `did` signed among the first
 * `verified` chained entries, those that verified with the identity evidence
 * already held (08b review r2 #5). A hash-chained line anyone can append,
 * whose proof does not verify, chooses nothing once an entry by `did` has
 * verified. An editor entry is signed by its editor; the author reference it
 * carries is its parent's and says nothing of where the author is now.
 *
 * P5.14 (08b review r4 #5; originals-spec #51, merged): when the evidence held verifies no
 * entry `did` signed (a reader with no evidence for it), no proof can be
 * checked before the log is retrieved. The location named by the earliest
 * chained entry `did` signed (the genesis entry for the author), which is
 * bound to the Original's SCID and so cannot be steered by a line appended
 * to someone else's Original, is tried first; P5.14's latest chained entry
 * only when that location gives no usable log. A log retrieved from the
 * earlier location verifies the entries, and the latest verified entry then
 * names the location retrieved next (`withIdentities`). The verifier checks
 * that a retrieved log came from the latest verified entry's location, so an
 * unverified line can choose a request but never the result.
 */
function identityLocations(chained: ChainedEntry[], did: string, verified: number): string[] {
  const signedBy = (i: number) => {
    const state = chained[i].state;
    const signer = isJsonObject(state) ? (isJsonObject(state.editor) ? state.editor : state.author) : undefined;
    return isJsonObject(signer) && signer.did === did && typeof signer.verificationMethod === "string" ? signerLocation(signer as unknown as AuthorRef) : undefined;
  };
  for (let i = Math.min(verified, chained.length) - 1; i >= 0; i--) {
    const location = signedBy(i);
    if (location) return [location];
  }
  const out: string[] = [];
  for (let i = Math.min(verified, chained.length); i < chained.length; i++) {
    const location = signedBy(i);
    if (location) {
      out.push(location);
      break;
    }
  }
  for (let i = chained.length - 1; i >= Math.min(verified, chained.length); i--) {
    const location = signedBy(i);
    if (location) {
      if (!out.includes(location)) out.push(location);
      break;
    }
  }
  return out;
}

/**
 * Where a did:webvh log held for an identity says it now is: the `id` of its
 * last version, when that is a did:webvh. Only a request; the verifier uses
 * what is found there only if it verifies from the identity's genesis, and
 * establishes freshness only if that log's own latest version names the
 * location (P5.14, P7.8).
 */
function movedTo(evidence: AuthorDidEvidence | undefined): string[] {
  // Any verified log held, fetched or a copy from a package or host (P5.14; owner decision on #993's review).
  if (typeof evidence?.log !== "string") return [];
  const last = evidence.log.trimEnd().split("\n").pop();
  try {
    const state = last ? (JSON.parse(last) as { state?: { id?: unknown } }).state : undefined;
    return typeof state?.id === "string" && state.id.startsWith("did:webvh:") ? [state.id] : [];
  } catch {
    return [];
  }
}

/** The did:webvh log URL of `location`, or undefined when it is not a did:webvh. */
function logUrlOf(location: string): string | undefined {
  try {
    return didWebvhLogUrl(location);
  } catch (error) {
    if (error instanceof OriginalsError) return undefined;
    throw error;
  }
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

function aliasesOf(log: string): string[] {
  const out = new Set<string>();
  for (const line of lines(log)) {
    try {
      const entry = JSON.parse(line) as { state?: { asset?: { aliases?: unknown } } };
      const aliases = entry.state?.asset?.aliases;
      if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === "string") out.add(a);
    } catch {
      // Verification reports the malformed line.
    }
  }
  return [...out];
}

function checkAnswer(answer: unknown, did: string): HostAnswer {
  const a = answer as Partial<Record<"status" | "checkpoint" | "head", unknown>> | null;
  const ok =
    typeof a === "object" && a !== null && typeof a.head === "string" &&
    (a.status === "stale-parent" || ((a.status === "accepted" || a.status === "already-accepted") && typeof a.checkpoint === "string"));
  if (!ok) sdkError("invalid-evidence", "HOST_ANSWER_INVALID", `the host's answer for ${did} is not accepted, already-accepted or stale-parent`);
  return a as HostAnswer;
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

  /**
   * Signer identity evidence for a log, looked up by identity DID (P5.14): an
   * evidence package's own, the author source's, and the store's; then, with
   * `identityFetch`, the log at the identity's current location, if it
   * extends that. Of what is supplied, configured and kept, the one with the
   * newest verified version is used, compared by verified versionIds and never
   * by bytes, so older evidence never rolls a newer DID log back, in
   * verification or in what is published (P7.8, P7.9; originals-spec #47,
   * merged; #965 review C2). With `retained`, the newest
   * verified versionId known is retained for the DID, so evidence that falls
   * short of it is stale; evidence that diverges is an identity fork, reported
   * as incomplete identity evidence (AUTHOR_DID_FORK), never as the package's.
   */
  private async authorEvidence(log: string, supplied: AuthorDidEvidence[] = [], others: string[] = [], retained?: RetainedVersions): Promise<AuthorDidEvidence[]> {
    const out: AuthorDidEvidence[] = [];
    // Other branches compared with this log are verified too, and their editors may differ (P6.6).
    const dids = [...new Set([log, ...others].flatMap(signerDidsOf))];
    for (const did of dids) {
      const given = supplied.find((a) => a.did === did);
      const candidates = [...(given ? [given] : []), ...(await this.configuredAndStored(did))];
      const found = newestEvidence(await Promise.all(candidates.map((c) => this.held(c))));
      if (!found) continue;
      out.push(found.chosen);
      if (retained) {
        const authors = (retained.authors ??= {});
        if (found.fork) authors[did] = found.fork;
        else if (found.newest) authors[did] = higherVersion(authors[did], found.newest);
      }
    }
    return out;
  }

  /** The author source's evidence for `did`, then this store's, as candidates (P7.8). */
  private async configuredAndStored(did: string): Promise<AuthorDidEvidence[]> {
    const source = this.options.authors;
    const found = Array.isArray(source) ? source.find((a) => a.did === did) : await source(did);
    const configured = found ? { ...found, source: found.source ?? ("supplied" as const) } : undefined;
    const kept = await this.store.getAuthorEvidence(did);
    // Kept by this store when it verified it (P7.8): when and where it was first obtained is kept with it.
    const stored = kept ? { ...kept, source: "retained" as const } : undefined;
    return [...(configured ? [configured] : []), ...(stored ? [stored] : [])];
  }

  /** `evidence` with the versionIds of its log that verify; none when its method is not verified here. */
  private async held(evidence: AuthorDidEvidence): Promise<HeldEvidence> {
    try {
      const h = await verifyAuthorHistory(evidence, { now: this.clock() });
      return { evidence, ids: h.versions.map((v) => v.versionId), complete: !h.failure };
    } catch (error) {
      if (error instanceof OriginalsError) return { evidence, ids: undefined, complete: false };
      throw error;
    }
  }

  /** `evidence` as obtained now, from `source` (P7.10). */
  private obtained(evidence: AuthorDidEvidence, source: "package" | "host" | "fetched"): AuthorDidEvidence {
    return { ...evidence, obtainedAt: new Date(this.clock()).toISOString(), source };
  }

  /** `identityFetch`, with a fetcher's TypeError (offline, DNS) treated as unavailable. */
  private identityFetcher(): HostedFetch | undefined {
    const fetch = this.options.identityFetch;
    if (!fetch) return undefined;
    return async (url, options) => {
      try {
        return await fetch(url, options);
      } catch (error) {
        if (error instanceof TypeError) throw new OriginalsError("unavailable-bytes", "FETCH_FAILED", `${url} could not be retrieved`);
        throw error;
      }
    };
  }

  /**
   * Verify with `base` identity evidence; then, with `identityFetch`, retrieve
   * each retrievable identity's log from its latest location (P5.14) and
   * verify again with what was retrieved. Requests count in `retrieval`, the
   * call's budget (`loadPublished`), whose exhaustion, deadline or abort ends
   * the call. Any other operation gets a budget of its own from
   * `retrievalLimits`; when that runs out, what was not retrieved stays
   * unretrieved and its freshness is not established (P7.8).
   */
  private async withIdentities(
    log: string,
    base: AuthorDidEvidence[],
    run: (authors: AuthorDidEvidence[]) => Promise<OriginalsReport>,
    retrieval?: Retrieval,
  ): Promise<{ report: OriginalsReport; authors: AuthorDidEvidence[] }> {
    let report = await run(base);
    let authors = base;
    const fetch = this.identityFetcher();
    if (!fetch) return { report, authors };
    const budget = retrieval ?? new Retrieval(fetch, this.options.retrievalLimits, this.options.archiveLimits, undefined, "identity retrieval");
    const tried = new Set<string>();
    try {
      // A retrieved author log can verify entries whose states grant editors, and a log first retrieved
      // where an unverified entry said (`identityLocations`) verifies entries whose latest may name
      // another location: further rounds retrieve from those.
      for (let round = 0; round < 3; round++) {
        const next = await this.identityRound(log, authors, report.history.entries, budget, fetch, tried);
        if (next === authors) break;
        authors = next;
        report = await run(authors);
      }
    } catch (error) {
      if (retrieval || !(error instanceof OriginalsError) || (error.code !== "RETRIEVAL_BUDGET_EXCEEDED" && error.code !== "RETRIEVAL_ABORTED")) throw error;
      // This operation's own budget ran out: what was retrieved is used, the rest is not established.
      if (authors !== base) report = await run(authors);
    } finally {
      if (!retrieval) budget.close();
    }
    return { report, authors };
  }

  /**
   * One round of identity retrieval: each retrievable did:webvh identity, at
   * each of its locations (`identityLocations`) not yet tried, up to two
   * requests each (its log and witness file), planned before any is made.
   * Returns `base` itself when nothing new was retrieved.
   */
  private async identityRound(
    log: string,
    base: AuthorDidEvidence[],
    verified: number,
    budget: Retrieval,
    fetch: HostedFetch,
    tried = new Set<string>(),
  ): Promise<AuthorDidEvidence[]> {
    const chained = chainedEntries(log);
    // Only an identity that signed a chained entry has a location to retrieve from; none is asked twice.
    // P5.14 (originals-spec #51, merged): and where a log held for it says the DID now is, when that is elsewhere.
    const plan = retrievableIdentities(chained, verified)
      .filter((did) => did.startsWith("did:webvh:"))
      .map((did) => ({ did, locations: [...new Set([...identityLocations(chained, did, verified), ...movedTo(base.find((a) => a.did === did))])].filter((l) => !tried.has(`${did} ${logUrlOf(l)}`)) }))
      .filter((p) => p.locations.length > 0);
    if (plan.length === 0) return base;
    budget.plan(2 * plan.reduce((n, p) => n + p.locations.length, 0), 0);
    let out = base;
    for (const { did, locations } of plan) {
      const known = out.find((a) => a.did === did);
      const retrieved = await this.retrieveIdentity(did, locations, known, budget, fetch, (l) => tried.add(`${did} ${logUrlOf(l)}`));
      if (retrieved) out = known ? out.map((a) => (a.did === did ? retrieved : a)) : [...out, retrieved];
    }
    return out;
  }

  /** The evidence a package carries for `log`: as `verify` used it, identity retrieval included. */
  private async packagedIdentities(log: string, report: OriginalsReport): Promise<AuthorDidEvidence[]> {
    const base = await this.authorEvidence(log);
    const fetch = this.identityFetcher();
    if (!fetch) return base;
    const budget = new Retrieval(fetch, this.options.retrievalLimits, this.options.archiveLimits, undefined, "identity retrieval");
    let out = base;
    try {
      out = await this.identityRound(log, base, Math.min(report.history.entries, lines(log).length), budget, fetch);
    } catch (error) {
      if (!(error instanceof OriginalsError) || (error.code !== "RETRIEVAL_BUDGET_EXCEEDED" && error.code !== "RETRIEVAL_ABORTED")) throw error;
    } finally {
      budget.close();
    }
    return out;
  }

  /**
   * P5.14: retrieve a did:webvh identity's log from the location of the DID in
   * the verification method id of the latest entry it signed, with no
   * redirects (P8.5). Used only when it verifies from the identity DID's
   * genesis and extends `known`. The locations come from `identityLocations`;
   * they only choose the URL, and the verifier checks that the URL is the
   * latest verified entry's location.
   */
  private async retrieveIdentity(
    did: string,
    locations: string[],
    known: AuthorDidEvidence | undefined,
    retrieval: Retrieval,
    fetch: HostedFetch,
    asked: (location: string) => void = () => undefined,
  ): Promise<AuthorDidEvidence | undefined> {
    for (const location of locations) {
      asked(location);
      const found = await this.retrieveIdentityAt(did, location, known, retrieval, fetch);
      if (found) return found;
    }
    return undefined;
  }

  /** `did`'s log retrieved from `location` (with its witness file), when it verifies from genesis and extends `known`. */
  private async retrieveIdentityAt(did: string, location: string, known: AuthorDidEvidence | undefined, retrieval: Retrieval, fetch: HostedFetch): Promise<AuthorDidEvidence | undefined> {
    let url: string;
    try {
      if (parseDidWebvh(location).scid !== parseDidWebvh(did).scid) return undefined;
      url = didWebvhLogUrl(location);
    } catch (error) {
      if (error instanceof OriginalsError) return undefined;
      throw error;
    }
    const get = async (target: string): Promise<string | undefined> => {
      try {
        const data = await retrieval.get(target, { required: false, archive: false, fetch });
        return data === undefined ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch (error) {
        // The budget's own end stops the round; anything else leaves the identity unretrieved.
        if (error instanceof OriginalsError && (error.code === "RETRIEVAL_BUDGET_EXCEEDED" || error.code === "RETRIEVAL_ABORTED")) throw error;
        if (error instanceof OriginalsError || error instanceof TypeError) return undefined; // unavailable: freshness stays not established
        throw error;
      }
    };
    const text = await get(url);
    if (text === undefined) return undefined;
    const witnessText = await get(url.replace(/did\.jsonl$/, "did-witness.json"));
    let witness: unknown;
    try {
      witness = witnessText === undefined ? undefined : parseJson(witnessText);
    } catch (error) {
      if (error instanceof OriginalsError) return undefined;
      throw error;
    }
    const candidate: AuthorDidEvidence = this.obtained({ did, log: text, ...(witness !== undefined ? { witness } : {}), retrievedFrom: url }, "fetched");
    const ids = async (evidence: AuthorDidEvidence) => {
      const h = await verifyAuthorHistory(evidence, { now: this.clock() });
      return h.failure ? undefined : h.versions.map((v) => v.versionId);
    };
    const retrieved = await ids(candidate);
    if (!retrieved || retrieved.length === 0) return undefined;
    if (known) {
      const have = await ids(known);
      if (have && !have.every((id, i) => retrieved[i] === id)) return undefined; // shorter or diverging: not used
    }
    return candidate;
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
    const anchor = did && this.store.getRetainedAnchor ? await quietly(() => this.store.getRetainedAnchor!(did), undefined) : undefined;
    if (anchor) retained.anchor = anchor;
    for (const author of signerDidsOf(log)) {
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
    if (report.original && report.retain.anchor && this.store.putRetainedAnchor) await this.store.putRetainedAnchor(report.original, report.retain.anchor);
  }

  /** Alias logs this store keeps for the aliases a log lists (stored with the DID evidence). */
  private async aliasEvidence(log: string, supplied: AliasEvidence[] = []): Promise<AliasEvidence[]> {
    const out: AliasEvidence[] = [];
    for (const did of aliasesOf(log).filter((a) => a.startsWith("did:webvh:"))) {
      const found = supplied.find((a) => a.did === did) ?? (await this.store.getAuthorEvidence(did));
      if (found?.log !== undefined) out.push({ did: found.did, log: found.log, ...(found.witness !== undefined ? { witness: found.witness } : {}) });
    }
    return out;
  }

  private async verify(log: string, checkpoint?: string, extra?: ReadonlyMap<string, Uint8Array>, bitcoin?: SatEvidence[]): Promise<OriginalsReport> {
    const aliases = await this.aliasEvidence(log);
    const bytes = await this.storedBytes(log, extra);
    const comparisons = await this.comparisons(log);
    const run = (authors: AuthorDidEvidence[]) =>
      verifyOriginal({
        log,
        ...(bitcoin ? { bitcoin } : {}),
        aliases,
        authors,
        bytes,
        now: this.clock(),
        ...comparisons,
        ...(checkpoint ? { checkpoint } : {}),
      });
    const base = await this.authorEvidence(log, [], (comparisons.copies ?? []).flatMap((c) => (typeof c.log === "string" ? [c.log] : [])), comparisons.retained);
    return (await this.withIdentities(log, base, run)).report;
  }

  private view(did: string, report: OriginalsReport): OriginalView {
    if (!report.checkpoint || !report.state || !report.head) {
      const failure = report.history.failure;
      sdkError(failure?.category ?? "incomplete-evidence", "ORIGINAL_NOT_VERIFIED", `${did} has no verified checkpoint: ${failure?.message ?? report.reasons.join(", ")}`, { report });
    }
    return { did, checkpoint: report.checkpoint, head: report.head, state: report.state, resources: report.resources.versions, current: report.current, validAsOf: report.validAsOf, report };
  }

  private async stored(did: string): Promise<string> {
    const stored = await this.store.get(did);
    if (!stored) sdkError("incomplete-evidence", "ORIGINAL_NOT_FOUND", `${did} is not in this store`);
    return stored.log;
  }

  /**
   * The committed log of a stored Original, exactly as stored and not
   * verified: the committed head is its last line. The Bitcoin writer
   * inscribes these exact lines (P9.17); read state through `get`.
   */
  async committedLog(did: string): Promise<string> {
    return this.stored(did);
  }

  /**
   * The verified state of a stored Original, at its head or an exact
   * checkpoint (P3.2). For an anchored Original, pass what an adapter read
   * from the anchoring sat (`satEvidence`): Bitcoin then decides the log from
   * the anchor on, and without it the result is unverified (P9.12, P9.13).
   */
  async get(did: string, options: { checkpoint?: string; bitcoin?: SatEvidence[] } = {}): Promise<OriginalView> {
    const log = await this.stored(did);
    const report = await this.verify(log, options.checkpoint, undefined, options.bitcoin);
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
    exactKeys(input, ["name", "metadata", "resources", "author", "signer", "editors"], "create input");
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
      ...(input.editors !== undefined ? { editors: input.editors } : {}),
    });
    const summary = summarize(entry);
    return Promise.resolve({ kind: "draft", signed: false, original: entry.state.id as string, parent: null, entry, summary, display: describeEntry(summary), bytes });
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
    exactKeys(input, ["parent", "name", "metadata", "resources", "remove", "author", "editor", "editors", "signer"], "edit input");
    return this.prepareUpdate(did, input);
  }

  private async prepareUpdate(did: string, input: EditInput, aliases?: string[]): Promise<Draft> {
    const { head, view } = await this.parentOf(did, input.parent);
    const bytes = new Map<string, Uint8Array>();
    // P4.1: every resourceID the Original has used through its verified history, removed ones included.
    const used = new Set([...view.state.resources.map((r) => r.id), ...view.resources.map((v) => v.resource)]);
    if (input.remove !== undefined && (!Array.isArray(input.remove) || !input.remove.every((id) => typeof id === "string"))) {
      sdkError("invalid-evidence", "INPUT_INVALID", "remove must be a list of resourceIDs");
    }
    const resources = (input.resources ?? []).map((r, i) => {
      exactKeys(r, ["id", "bytes", "mediaType", "expectedDigest"], `resources[${i}]`);
      if (!(r.bytes instanceof Uint8Array)) sdkError("invalid-evidence", "INPUT_INVALID", `resources[${i}].bytes must be a Uint8Array`);
      const current = view.state.resources.find((c) => c.id === r.id);
      if (r.expectedDigest !== undefined && current?.digest !== r.expectedDigest) {
        sdkError("stale-parent", "STALE_DIGEST", `resource ${r.id} is at ${current?.digest ?? "nothing"}, not ${r.expectedDigest}`);
      }
      if (!current) {
        // An addition (P4.1): the author's only, a fresh id, and a media type of its own.
        if (input.editor !== undefined) sdkError("outside-grant", "EDITOR_AUTHOR_ONLY", `an editor cannot add a resource (${r.id}); only the author may (P4.1, P5.16)`);
        if (used.has(r.id)) sdkError("invalid-evidence", "STATE_RESOURCE_REUSED", `resourceID ${r.id} was used before in this Original and cannot be used again (P4.1)`);
        if (r.mediaType === undefined) sdkError("invalid-evidence", "INPUT_INVALID", `resources[${i}] adds ${r.id}, so it needs a mediaType`);
      }
      const digest = resourceDigest(r.bytes);
      bytes.set(digest, r.bytes.slice());
      return { id: r.id, mediaType: r.mediaType ?? current?.mediaType ?? "", size: r.bytes.length, digest };
    });
    if (input.editor !== undefined && (input.remove ?? []).length > 0) {
      sdkError("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor cannot remove a resource; only the author may (P4.1, P5.16)");
    }
    const entry = prepareUpdateOriginal(head, {
      versionTime: this.versionTime(head.versionTime),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      resources,
      ...(input.remove !== undefined ? { remove: input.remove } : {}),
      usedResourceIds: used,
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(input.editor !== undefined ? { editor: input.editor } : {}),
      ...(input.editors !== undefined ? { editors: input.editors } : {}),
      ...(aliases ? { aliases } : {}),
    });
    const summary = summarize(entry, head.state as unknown as EntryState);
    return { kind: "draft", signed: false, original: did, parent: input.parent, entry, summary, display: describeEntry(summary), bytes };
  }

  async edit(did: string, input: EditInput & { signer: OriginalsSigner }): Promise<CommitResult> {
    return this.commit(await this.prepareEdit(did, input), input.signer);
  }

  /** Only the author deactivates (P5.16, P6.5). */
  async prepareDeactivate(did: string, input: { parent: string; author: AuthorRef }): Promise<Draft> {
    exactKeys(input, ["parent", "author", "signer"], "deactivate input");
    const { head } = await this.parentOf(did, input.parent);
    const entry = prepareDeactivateOriginal(head, { versionTime: this.versionTime(head.versionTime), author: input.author });
    const summary = summarize(entry, head.state as unknown as EntryState);
    return { kind: "draft", signed: false, original: did, parent: input.parent, entry, summary, display: describeEntry(summary), bytes: new Map() };
  }

  async deactivate(did: string, input: { parent: string; author: AuthorRef; signer: OriginalsSigner }): Promise<CommitResult> {
    return this.commit(await this.prepareDeactivate(did, input), input.signer);
  }

  /**
   * Publish to the web (P3.6): one entry that lists `alias`. The alias log
   * must already point back to this Original, and it is kept with the store's
   * DID evidence so later reads confirm it.
   */
  async publish(did: string, input: { parent: string; author: AuthorRef; signer: OriginalsSigner; alias: AliasEvidence }): Promise<CommitResult> {
    exactKeys(input, ["parent", "author", "signer", "alias"], "publish input");
    const check = await checkAlias(did, input.alias, input.alias.did, this.clock());
    if (check.status !== "confirmed") {
      sdkError("invalid-evidence", "ALIAS_NOT_CONFIRMED", `${input.alias.did} does not point to ${did}: ${check.reason ?? check.message ?? check.status}`);
    }
    const draft = await this.prepareUpdate(did, { parent: input.parent, author: input.author }, [input.alias.did]);
    assertHostable(await this.stored(did));
    await this.store.putAuthorEvidence(input.alias);
    return this.commit(draft, input.signer);
  }

  /**
   * The anchoring entry (P9.10; plan 012 §3.1): an ordinary update that adds
   * the sat's did:btco alias. It counts only once inscribed on that sat; until
   * then reads report the Original as unverified on Bitcoin. Inscribing it is
   * the Bitcoin writer's job (plan 011, PR 10). The anchoring inscription
   * carries the whole log through this entry, so an Original whose log would
   * then exceed 350,000 bytes is refused before anything is committed
   * (ANCHORING_LOG_TOO_LARGE, P9.17).
   */
  async anchor(did: string, input: { parent: string; author: AuthorRef; signer: OriginalsSigner; sat: string }): Promise<CommitResult> {
    exactKeys(input, ["parent", "author", "signer", "sat"], "anchor input");
    parseBtcoAlias(input.sat);
    const aliases = (await this.get(did)).state.aliases;
    if (aliases.some((a) => a.startsWith("did:btco:"))) sdkError("invalid-evidence", "ALREADY_ANCHORED", `${did} is already anchored (P9.10)`);
    const draft = await this.prepareUpdate(did, { parent: input.parent, author: input.author }, [...aliases, input.sat]);
    // The anchoring inscription carries the whole log through the anchoring entry, so a log
    // over the inscription limit cannot be anchored: refuse before committing it (P9.17).
    const candidate = await this.sign(draft, input.signer);
    const size = new TextEncoder().encode((await this.stored(did)) + serializeLog([candidate.entry])).length;
    if (size > ORIGINALS_INSCRIPTION_MAX_BYTES) {
      sdkError("limit-exceeded", "ANCHORING_LOG_TOO_LARGE", `the log of ${did} through the anchoring entry would be ${size} bytes; an inscription holds at most ${ORIGINALS_INSCRIPTION_MAX_BYTES} (P9.17)`, { size, limit: ORIGINALS_INSCRIPTION_MAX_BYTES });
    }
    return this.commitCandidate(candidate);
  }

  // ---------------------------------------------------------------- committing

  private readonly signedReports = new WeakMap<SignedCandidate, { log: string; report: OriginalsReport }>();

  private requireSigner(signer: OriginalsSigner, original: string): void {
    // Holding evidence is not authority (P8.4): with no usable signer there is nothing to sign with.
    if (typeof signer !== "object" || signer === null || typeof signer.sign !== "function") {
      sdkError("unauthorized-key", "SIGNER_REQUIRED", `committing to ${original} needs a signer for an author or editor key`);
    }
  }

  /** A refused candidate is never signed, committed or submitted again (P6.8). */
  private async notRefused(did: string, versionId: string): Promise<void> {
    if ((await this.store.getRefused(did)).some((r) => refusedVersionId(r) === versionId)) {
      sdkError("stale-parent", "CANDIDATE_REFUSED", `${versionId} was refused by a shared host; reconcile it into a new candidate against the new head (P6.8)`);
    }
  }

  /**
   * Sign a draft and verify the whole resulting history against its exact
   * parent, without committing anything (P6.1, P6.4). The result is a
   * candidate for `submit` to a shared host, or for `commit` locally.
   */
  async sign(draft: Draft, signer: OriginalsSigner): Promise<SignedCandidate> {
    this.requireSigner(signer, draft.original);
    await this.notRefused(draft.original, draft.entry.versionId);
    const stored = (await this.store.get(draft.original))?.log ?? "";
    const head = headOf(stored);
    if (head !== draft.parent) throw staleHead(draft.original, draft.parent, head);

    const proofOptions = { type: "DataIntegrityProof" as const, cryptosuite: signer.cryptosuite, verificationMethod: signer.verificationMethod, proofPurpose: "assertionMethod" };
    // The parent entry, so the signer can tell what this entry changes (P5.11).
    const storedLines = lines(stored);
    const parentEntry = storedLines.length > 0 ? (parseJson(storedLines[storedLines.length - 1]) as unknown as UnsignedEntry) : undefined;
    const predecessor = storedLines.length > 1 ? (parseJson(storedLines[storedLines.length - 2]) as { versionId: string }).versionId : undefined;
    const signature = await signer.sign({
      entry: draft.entry, proofOptions, summary: draft.summary, display: draft.display ?? describeEntry(draft.summary),
      ...(parentEntry ? { parent: { entry: parentEntry, ...(predecessor ? { predecessor } : {}) } } : {}),
    });
    const entry: LogEntry = { ...draft.entry, proof: [{ ...proofOptions, proofValue: multibaseEncode(signature) }] };
    const candidate = stored + serializeLog([entry]);

    const report = await this.verify(candidate, undefined, draft.bytes);
    const added = report.resources.versions.filter((v) => v.versionId === entry.versionId);
    if (
      report.history.status !== "valid" || report.history.entries !== lines(candidate).length ||
      report.authorBinding.status !== "valid" || report.identityEvidence.status !== "complete" ||
      added.some((v) => v.bytes !== "verified")
    ) {
      // An entry over a profile limit is limit-exceeded (P7.7); any other failure is invalid evidence.
      const category = report.history.failure?.category === "limit-exceeded" ? "limit-exceeded" : "invalid-evidence";
      sdkError(category, "COMMIT_VERIFICATION_FAILED", `the signed entry does not verify: ${report.history.failure?.message ?? report.reasons.join(", ")}`, { report });
    }
    const signed: SignedCandidate = {
      kind: "candidate", original: draft.original, parent: draft.parent, versionId: entry.versionId, entry, line: JSON.stringify(entry), summary: draft.summary, bytes: draft.bytes,
    };
    this.signedReports.set(signed, { log: candidate, report });
    return signed;
  }

  /** Sign, verify and durably commit a draft (P6.1, P6.2, P6.4). */
  async commit(draft: Draft, signer: OriginalsSigner): Promise<CommitResult> {
    this.requireSigner(signer, draft.original);
    const stored = (await this.store.get(draft.original))?.log ?? "";
    if (versionIds(stored).includes(draft.entry.versionId)) {
      return { status: "duplicate", original: await this.get(draft.original) };
    }
    return this.commitCandidate(await this.sign(draft, signer));
  }

  /** Store a verified candidate's new bytes, then replace the log atomically (P6.2). */
  private async commitCandidate(candidate: SignedCandidate): Promise<CommitResult> {
    await this.notRefused(candidate.original, candidate.versionId);
    const stored = (await this.store.get(candidate.original))?.log ?? "";
    const log = stored + serializeLog([candidate.entry]);
    for (const [digest, bytes] of candidate.bytes) await this.store.putResource(digest, bytes);
    await this.store.commit(candidate.original, { expectedHead: candidate.parent, log });
    const signed = this.signedReports.get(candidate);
    const report = signed?.log === log ? signed.report : await this.verify(log);
    await this.retain(report);
    return { status: "committed", original: this.view(candidate.original, report) };
  }

  // ---------------------------------------------------------------- shared hosts

  /**
   * Save a signed candidate through a shared host (P6.7, P6.8). Accepted or
   * already accepted: the candidate is committed locally and returned with
   * the host's head. Stale parent: the draft and the signed candidate are
   * kept, labelled `refused`, local history does not move, and the result
   * names the host's head. A refused candidate is never submitted again.
   */
  async submit(candidate: SignedCandidate, host: SharedHost): Promise<SubmitResult> {
    if (candidate?.kind !== "candidate" || typeof candidate.line !== "string") sdkError("invalid-evidence", "INPUT_INVALID", "submit takes a candidate from sign()");
    const did = candidate.original;
    await this.notRefused(did, candidate.versionId);
    const stored = await this.stored(did);
    const committed = lines(stored).includes(candidate.line);
    if (!committed && headOf(stored) !== candidate.parent) throw staleHead(did, candidate.parent, headOf(stored));
    // A shared host serves what it accepts (P6.7): nothing it could not serve is sent (P8.5, P14.13).
    assertHostable(committed ? stored : `${stored.trimEnd()}\n${candidate.line}`);
    // Kept before it is sent, with its staged bytes, so a lost acknowledgement is retried with the
    // same signed bytes (P6.4). Staged bytes are content addressed and never a version on their own (P6.1).
    for (const [digest, bytes] of candidate.bytes) await this.store.putResource(digest, bytes);
    await this.store.putPending(did, { parent: candidate.parent, entry: candidate.line });
    const answer = checkAnswer(
      await host.submit({ original: did, entry: candidate.line, resources: Object.fromEntries(candidate.bytes), identities: await this.authorEvidence(stored ? `${stored.trimEnd()}\n${candidate.line}` : candidate.line) }),
      did,
    );
    if (answer.status === "stale-parent") {
      if (answer.head === candidate.parent) sdkError("invalid-evidence", "HOST_ANSWER_INVALID", `the host refused ${candidate.versionId} as stale while naming its parent as the head`);
      await this.store.putPending(did, null);
      // Already local history: the host and this store have diverged, which is a fork, not a refusal (P6.6).
      if (committed) {
        sdkError("fork", "HOST_DIVERGES", `${candidate.versionId} is committed locally but the host's head ${answer.head} does not extend it; sync keeps the host's branch beside local history (P6.6)`, { hostHead: answer.head });
      }
      const record: StoredRefused = { label: "refused", parent: candidate.parent!, entry: candidate.line, hostHead: answer.head };
      await this.store.putRefused(did, record);
      return { status: "stale-parent", hostHead: answer.head, refused: await this.hydrateRefused(did, record) };
    }
    if (answer.checkpoint !== candidate.versionId) {
      sdkError("invalid-evidence", "HOST_ANSWER_INVALID", `the host answered for ${answer.checkpoint}, not ${candidate.versionId}`);
    }
    const original = committed ? await this.get(did) : (await this.commitCandidate(candidate)).original;
    await this.store.putPending(did, null);
    return { status: answer.status, checkpoint: candidate.versionId, hostHead: answer.head, behind: answer.head !== candidate.versionId, original };
  }

  /**
   * The candidate last sent to a shared host for `did` and not yet answered,
   * if any: after a lost acknowledgement or a crash, `submit` it again, byte
   * for byte, rather than preparing a new one (P6.4, P6.7).
   */
  async pending(did: string): Promise<SignedCandidate | undefined> {
    const record = await this.store.getPending(did);
    if (!record) return undefined;
    const entry = parseJson(record.entry) as unknown as LogEntry;
    const { proof: _proof, ...unsigned } = entry;
    const parentLine = lines((await this.store.get(did))?.log ?? "").find((line) => (JSON.parse(line) as { versionId?: unknown }).versionId === record.parent);
    const previous = parentLine ? ((parseJson(parentLine) as unknown as LogEntry).state as unknown as EntryState) : undefined;
    const bytes = new Map<string, Uint8Array>();
    for (const t of (unsigned.state as unknown as EntryState).transitions) {
      if (t.to === null) continue; // a removal brings no new bytes (P4.1)
      const data = await this.store.getResource(t.to);
      if (data && resourceDigest(data) === t.to) bytes.set(t.to, data);
    }
    return { kind: "candidate", original: did, parent: record.parent, versionId: entry.versionId, entry, line: record.entry, summary: summarize(unsigned, previous), bytes };
  }

  /** The candidates shared hosts refused for `did`, each with its draft (P6.8). */
  async refused(did: string): Promise<RefusedCandidate[]> {
    const out: RefusedCandidate[] = [];
    for (const record of await this.store.getRefused(did)) out.push(await this.hydrateRefused(did, record));
    return out;
  }

  private async hydrateRefused(did: string, record: StoredRefused): Promise<RefusedCandidate> {
    const entry = parseJson(record.entry) as unknown as LogEntry;
    const { proof: _proof, ...unsigned } = entry;
    const parentLine = lines((await this.store.get(did))?.log ?? "").find((line) => (JSON.parse(line) as { versionId?: unknown }).versionId === record.parent);
    const previous = parentLine ? ((parseJson(parentLine) as unknown as LogEntry).state as unknown as EntryState) : undefined;
    const bytes = new Map<string, Uint8Array>();
    for (const t of (unsigned.state as unknown as EntryState).transitions) {
      if (t.to === null) continue; // a removal brings no new bytes (P4.1)
      const data = await this.store.getResource(t.to);
      if (data && resourceDigest(data) === t.to) bytes.set(t.to, data);
    }
    const summary = summarize(unsigned, previous);
    const draft: Draft = { kind: "draft", signed: false, original: did, parent: record.parent, entry: unsigned, summary, display: describeEntry(summary), bytes };
    return { label: "refused", original: did, parent: record.parent, versionId: entry.versionId, entry, draft, hostHead: record.hostHead, ...(record.reconciledAs ? { reconciledAs: record.reconciledAs } : {}) };
  }

  /**
   * Fetch a shared host's accepted log and verify it (P6.8). A log that
   * extends local history is committed; one that diverges is kept as a
   * branch and reported as a fork (P6.6), exactly as `import` does.
   */
  async sync(did: string, host: SharedHost): Promise<ImportResult> {
    return this.importContents(await host.accepted(did), did, "host");
  }

  /**
   * Reconcile after a stale-parent conflict (P6.8): fetch and verify the
   * host's new head, prepare a candidate with the caller's reconciled change
   * against it, show the signer the change from the new head (P5.11) and
   * submit what the signer signs. The SDK never merges and never signs on its
   * own; a host that diverges from local history is a fork, not a parent.
   */
  async reconcile(did: string, input: ReconcileInput): Promise<SubmitResult> {
    exactKeys(input, ["host", "refused", "author", "signer", "change"], "reconcile input");
    if (input.change === undefined || input.change === null) {
      sdkError("invalid-evidence", "RECONCILE_CHANGE_REQUIRED", "reconcile needs the reconciled change; the SDK never merges (P6.8)");
    }
    this.requireSigner(input.signer, did);
    const kept = input.refused === undefined ? undefined : (await this.refused(did)).find((r) => r.versionId === input.refused);
    if (input.refused !== undefined && !kept) sdkError("invalid-evidence", "REFUSED_NOT_FOUND", `${input.refused} is not a refused candidate of ${did}`);
    const synced = await this.sync(did, input.host);
    if (synced.status === "conflict") {
      sdkError("fork", "HOST_DIVERGES", `the host's history of ${did} diverges from local history; it is kept as a branch (P6.6)`, { report: synced.original.report });
    }
    const head = synced.original;
    const change = typeof input.change === "function" ? await input.change({ head, ...(kept ? { refused: kept } : {}) }) : input.change;
    if (typeof change !== "object" || change === null) sdkError("invalid-evidence", "RECONCILE_CHANGE_REQUIRED", "reconcile needs the reconciled change; the SDK never merges (P6.8)");
    exactKeys(change, ["name", "metadata", "resources", "remove"], "reconciled change");
    const draft = await this.prepareEdit(did, { ...change, parent: head.checkpoint, author: input.author });
    const result = await this.submit(await this.sign(draft, input.signer), input.host);
    // The refused candidate stays, labelled with what carried its change (P6.8).
    if (result.status !== "stale-parent" && kept) {
      const record = (await this.store.getRefused(did)).find((r) => refusedVersionId(r) === kept.versionId);
      if (record) await this.store.putRefused(did, { ...record, reconciledAs: draft.entry.versionId });
    }
    return result;
  }

  // ---------------------------------------------------------------- evidence

  /** An evidence package for the head or an exact checkpoint (P7.1). */
  async package(did: string, options: { checkpoint?: string } = {}): Promise<EvidencePackage> {
    const log = await this.stored(did);
    const view = await this.get(did, options);
    const ids = versionIds(log);
    const prefix = `${lines(log).slice(0, ids.indexOf(view.checkpoint) + 1).join("\n")}\n`;
    // A did:btco signer's history is read from Bitcoin, not packaged; it is listed as missing (P5.13).
    const authors = (await this.packagedIdentities(prefix, view.report))
      .filter((a) => a.log !== undefined)
      .map(({ did, log, witness }) => ({ did, log, ...(witness !== undefined ? { witness } : {}) }));
    const missing: MissingItem[] = [];
    const editorDids = new Set(signerDidsOf(prefix).filter((d) => d !== (view.report.identityEvidence.author ?? undefined)));
    for (const did of signerDidsOf(prefix)) if (!authors.some((a) => a.did === did)) missing.push({ kind: "identity", did, role: editorDids.has(did) ? "editor" : "author" });
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

  /**
   * Verify an evidence package without storing it. Needs no key (P7.3), and
   * no network unless `identityFetch` is configured; its requests are then
   * bounded by a budget of their own (`retrievalLimits`).
   */
  async load(zip: Uint8Array, options: { bitcoin?: SatEvidence[] } = {}): Promise<LoadedEvidence> {
    return this.loadContents(readEvidence(zip, this.options.archiveLimits), "package", [], undefined, options.bitcoin);
  }

  private async loadContents(
    contents: EvidenceContents,
    from: "package" | "host",
    aliases: AliasEvidence[] = [],
    retrieval?: Retrieval,
    bitcoin?: SatEvidence[],
  ): Promise<LoadedEvidence> {
    const aliasEvidence = await this.aliasEvidence(contents.log, aliases);
    const comparisons = await this.comparisons(contents.log);
    const run = (authors: AuthorDidEvidence[]) =>
      verifyOriginal({
        ...(bitcoin ? { bitcoin } : {}),
        aliases: aliasEvidence,
        log: contents.log,
        authors,
        bytes: contents.bytes,
        checkpoint: contents.manifest.checkpoint,
        now: this.clock(),
        ...comparisons,
      });
    // A host's snapshot is a copy, like a package: no fetch location, so the location rule does not
    // apply to its signer logs (P7.8; owner decision on #993's review).
    const supplied = contents.authors.map(({ did, log, witness }) => this.obtained({ did, log, ...(witness !== undefined ? { witness } : {}) }, from));
    const base = await this.authorEvidence(contents.log, supplied, (comparisons.copies ?? []).flatMap((c) => (typeof c.log === "string" ? [c.log] : [])), comparisons.retained);
    const { report } = await this.withIdentities(contents.log, base, run, retrieval);
    const reasons = [...report.reasons];
    const m = contents.manifest;
    if (m.original !== report.original) reasons.push("manifest-original-mismatch");
    if (m.checkpoint !== m.head) reasons.push("package-checkpoint-is-not-its-head");
    const actuallyComplete = report.resources.missing.length === 0 && report.identityEvidence.status === "complete";
    if ((m.completeness === "complete") !== actuallyComplete) reasons.push("manifest-completeness-mismatch");
    return { manifest: m, report: { ...report, current: report.current && reasons.length === report.reasons.length }, reasons };
  }

  /**
   * The public reader (P9.1, P3.6). Retrieve the snapshot hosted under the
   * alias did:webvh's `#files` base with `fetch`, and verify that exact
   * checkpoint with no key. Missing bytes are reported as unavailable content
   * and do not fail the result (P7.3, P7.4);
   * an alias that does not name this Original in both directions gives no
   * result (ALIAS_NOT_CONFIRMED).
   *
   * Retrieval is bounded as a whole (issue #970; `retrievalLimits`, which
   * follow `archiveLimits`): the number of requests, the bytes accepted, and
   * the time, as well as `options.signal`. The manifest is checked, and the
   * requests the unverified asset log asks for are checked for shape and
   * number, before any of them is made; a line without that shape stops
   * them all with SNAPSHOT_LOG_INVALID (its rule's category). An exhausted
   * budget is a `limit-exceeded` RETRIEVAL_BUDGET_EXCEEDED error, a caller's
   * abort RETRIEVAL_ABORTED; neither is ever a result.
   */
  async loadPublished(aliasDid: string, fetch: HostedFetch, options: { signal?: AbortSignal } = {}): Promise<PublishedOriginal> {
    const retrieval = new Retrieval(fetch, this.options.retrievalLimits, this.options.archiveLimits, options.signal);
    try {
      return await this.retrievePublished(aliasDid, retrieval);
    } finally {
      retrieval.close();
    }
  }

  /**
   * Retrieve the snapshot hosted under a did:webvh alias, unverified, within
   * the same bounds as `loadPublished`. A shared host's `accepted` can use it
   * to give `sync` and `reconcile` the host's accepted log, which they verify
   * before using any of it (P6.8).
   */
  async retrieveHosted(aliasDid: string, fetch: HostedFetch, options: { signal?: AbortSignal } = {}): Promise<EvidenceContents> {
    const retrieval = new Retrieval(fetch, this.options.retrievalLimits, this.options.archiveLimits, options.signal);
    try {
      return readEvidenceFiles((await this.retrieveSnapshot(aliasDid, retrieval, false)).files);
    } finally {
      retrieval.close();
    }
  }

  /** `identities`: plan the identity requests the verification that follows makes in the same budget. */
  private async retrieveSnapshot(aliasDid: string, retrieval: Retrieval, identities: boolean): Promise<{ alias: AliasEvidence; files: Map<string, Uint8Array> }> {
    // A hosted file that is not UTF-8 is invalid evidence, as in a package (EVIDENCE_ENCODING).
    const text = (data: Uint8Array, name: string) => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        return sdkError("invalid-evidence", "EVIDENCE_ENCODING", `${name} is not UTF-8`);
      }
    };
    const logUrl = didWebvhLogUrl(aliasDid);
    const witnessUrl = logUrl.replace(/did\.jsonl$/, "did-witness.json");
    const aliasWitness = await retrieval.get(witnessUrl, { required: false, archive: false });
    const aliasLog = (await retrieval.get(logUrl, { required: true, archive: false }))!;
    const alias: AliasEvidence = { did: aliasDid, log: text(aliasLog, logUrl), ...(aliasWitness ? { witness: parseJson(text(aliasWitness, witnessUrl)) } : {}) };

    const base = `${didWebvhFilesUrl(aliasDid)}${HOSTED_PREFIX}`;
    const files = new Map<string, Uint8Array>();
    const put = async (path: string, required: boolean, resource = false) => {
      const data = await retrieval.get(`${base}${path}`, { required, archive: true, resource });
      if (data) files.set(path, data);
      return data;
    };
    readManifest((await put(MANIFEST, true))!);
    const log = text((await put("asset/did.jsonl", true))!, `${base}asset/did.jsonl`);
    // The log is unverified: what it asks for is checked for shape and number before any of it is requested.
    const plan = retrievalPlan(log);
    // Each signer's log and witness file, and each resource; no asset witness file (P9.8; P14.10, PROVISIONAL, section 14).
    const planned = 2 * plan.authors.length + plan.digests.length;
    // With identityFetch, up to six more requests per did:webvh signer (P5.14), in the same budget:
    // a log and witness file from up to two locations, then from the latest verified location.
    const identityRequests = identities && this.options.identityFetch ? 6 * plan.authors.filter((did) => did.startsWith("did:webvh:")).length : 0;
    retrieval.plan(planned + identityRequests, files.size + planned);
    for (const did of plan.authors) {
      if (await put(`${signerPath(did)}/did.jsonl`, false)) await put(`${signerPath(did)}/did-witness.json`, false);
    }
    for (const digest of plan.digests) await put(`resources/${digest}`, false, true);
    return { alias, files };
  }

  private async retrievePublished(aliasDid: string, retrieval: Retrieval): Promise<PublishedOriginal> {
    const { alias, files } = await this.retrieveSnapshot(aliasDid, retrieval, true);
    // Every file is already within the budget and the archive limits; no archive is assembled.
    const loaded = await this.loadContents(readEvidenceFiles(files), "host", [alias], retrieval);
    const r = loaded.report;
    // Both directions (P3.6): the checkpoint's own state must list the alias. A did:webvh that
    // merely points at an Original gives no result through it.
    const aliasReport = r.aliases.find((a) => a.did === aliasDid);
    if (!aliasReport || aliasReport.status !== "confirmed" || loaded.manifest.original !== r.original) {
      sdkError("invalid-evidence", "ALIAS_NOT_CONFIRMED", `${aliasDid} and the Original it is served with do not name each other`, { report: r });
    }
    const reasons = [...loaded.reasons];
    if (r.head !== loaded.manifest.checkpoint) reasons.push("snapshot-history-is-not-its-checkpoint");
    const verified =
      r.history.status === "valid" && r.authorBinding.status === "valid" && r.identityEvidence.status === "complete" &&
      r.resources.status !== "digest-failure" && r.checkpoint === loaded.manifest.checkpoint && r.head === loaded.manifest.checkpoint && r.fork === null;
    return { ...loaded, reasons, alias: aliasReport, verified };
  }

  /**
   * Verify a package and store it, unless that would roll back or replace
   * local history (P7.5). A diverging branch is kept beside the local one and
   * reported as a fork. Author evidence is stored only when it is at least as
   * new as what this store has verified (P7.8).
   */
  async import(zip: Uint8Array): Promise<ImportResult> {
    return this.importContents(readEvidence(zip, this.options.archiveLimits));
  }

  private async importContents(contents: EvidenceContents, expected?: string, from: "package" | "host" = "package"): Promise<ImportResult> {
    const loaded = await this.loadContents(contents, from);
    const r = loaded.report;
    if (!r.original || r.history.status !== "valid" || r.authorBinding.status !== "valid" || r.identityEvidence.status !== "complete") {
      sdkError("invalid-evidence", "IMPORT_REJECTED", "the package does not verify", { report: r });
    }
    if (expected !== undefined && r.original !== expected) {
      sdkError("invalid-evidence", "IMPORT_REJECTED", `the evidence is for ${r.original}, not ${expected}`, { report: r });
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
        await this.keepEvidence(contents, r, from);
        await this.store.putBranch(did, contents.log);
        return result("conflict");
      }
    }
    // A refused candidate is never history (P6.8): a log carrying one is kept as a branch, a fork (P6.6).
    const refused = new Set((await this.store.getRefused(did)).map(refusedVersionId));
    if (incoming.some((id) => refused.has(id))) {
      await this.keepEvidence(contents, r, from);
      await this.store.putBranch(did, contents.log);
      return result("conflict");
    }
    await this.keepEvidence(contents, r, from);
    await this.store.commit(did, { expectedHead: headOf(local), log: contents.log });
    return result("imported");
  }

  private async keepEvidence(contents: EvidenceContents, report: OriginalsReport, from: "package" | "host"): Promise<void> {
    for (const [digest, bytes] of Object.entries(contents.bytes)) {
      if (resourceDigest(bytes) === digest) await this.store.putResource(digest, bytes);
    }
    for (const evidence of contents.authors) {
      const history = await verifyAuthorHistory(evidence, { now: this.clock() });
      const latest = history.versions[history.versions.length - 1]?.versionId;
      // Kept with when and where it was obtained, which later reports state (P7.10).
      if (latest !== undefined && report.retain.authors[evidence.did] === latest) {
        await this.store.putAuthorEvidence(this.obtained({ did: evidence.did, log: evidence.log, ...(evidence.witness !== undefined ? { witness: evidence.witness } : {}) }, from));
      }
    }
  }
}

