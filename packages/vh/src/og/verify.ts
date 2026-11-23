/**
 * did:og verification: a report (P7.17–P7.23, P14.25) computed as a pure
 * function of a declared evidence set. Nothing here reads the network, the
 * clock or a cache: the same evidence set always gives the same report
 * (P7.17, T7-045). This module handles copies of the log (files, packages),
 * signer histories and resource bytes; the Bitcoin path (P9.10–P9.36) is in
 * `bitcoin.ts` and plugs in through `anchoredEvaluator`.
 */
import { OriginalsError } from "../errors.js";
import { isJsonObject, parseJsonLines, type JsonValue } from "../json/index.js";
import { checkLogStructure, parseLogFile, resourceDigest, versionNumber, isDeactivation, type OgEntry } from "./log.js";
import { ASSET_LOG_NAME, MANIFEST_NAME, readManifest, readPackageZip, signerDirectory, type Manifest } from "./package.js";
import { offlineFrom, outcomeOf, reportInputs, sortDiagnostics, type Axes, type Diagnostic, type EntryAuthority, type EntryLabel, type EvidenceInput, type EvidenceSet, type Report, type SignerLabel } from "./report.js";
import { OG_METHOD, OgRuleError } from "./rules.js";
import { byCodePoint, checkBinding, latestVersion, listsKey, lookupVersion, verifySignerLog, type SignerHistory, type SignerVersion } from "./signers.js";
import { advance, checkTransition, genesisContext, isAnchoringEntry, isEditorEntry, signerMethodOf, stateOf, type BranchContext, type SignerRef } from "./state.js";

// ---------------------------------------------------------------------------
// Gathering the evidence set

export interface LogCopy {
  source: string;
  values: JsonValue[];
  /** A line that fails P14.2/P14.3, which ends the copy. */
  lineFailure?: OriginalsError;
  /** The package this copy came from. */
  fromPackage?: { manifest: Manifest; complete: boolean };
}

export interface HistoryCandidate {
  did: string;
  entries: JsonValue[];
  witness?: unknown;
  source: string;
  obtained?: string;
}

export interface Gathered {
  copies: LogCopy[];
  histories: HistoryCandidate[];
  /** Resource bytes by digest; `mismatched` lists supplied bytes that match no descriptor they were offered as. */
  resources: Map<string, Uint8Array>;
  mismatched: Array<{ digest: string; source: string }>;
  packages: Array<{ source: string; manifest: Manifest; files: Record<string, Uint8Array> }>;
  unsupported?: string;
  /** Inputs that are not used: bytes that do not match their stated digest, or cannot be read as their kind (P7.17). */
  invalidInputs: Array<{ source: string; error: OriginalsError }>;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function gather(evidence: EvidenceSet): Gathered {
  const g: Gathered = { copies: [], histories: [], resources: new Map(), mismatched: [], packages: [], invalidInputs: [] };
  const notes = evidence.signerHistories ?? [];
  const noteFor = (did: string, source: string) => notes.find((n) => n.did === did && n.source === source) ?? notes.find((n) => n.source === source);
  const addResource = (bytes: Uint8Array, source: string, claimed?: string) => {
    const d = resourceDigest(bytes);
    if (claimed && claimed !== d) g.mismatched.push({ digest: claimed, source });
    else g.resources.set(d, bytes);
  };
  const pendingPackagedSigners: Array<{ dir: string; log: Uint8Array; witness?: Uint8Array }> = [];
  for (const input of evidence.inputs) {
    try {
      if (input.digest !== undefined && input.digest !== resourceDigest(input.bytes)) {
        throw new OgRuleError("P7.17", "INPUT_DIGEST", `the bytes of ${input.source} do not match its stated digest`);
      }
      switch (input.kind) {
        case "log": {
          const parsed = parseLogFile(input.bytes);
          g.copies.push({ source: input.source, values: parsed.values, lineFailure: parsed.failure?.error });
          break;
        }
        case "package": {
          const files = readPackageZip(input.bytes);
          if (!files[MANIFEST_NAME] || !files[ASSET_LOG_NAME]) throw new OgRuleError("P14.10", "PACKAGE_MEMBERS", "a package holds originals-evidence.json and asset/did.jsonl");
          const parsed = parseLogFile(files[ASSET_LOG_NAME]);
          const ids = parsed.values.map((v) => (isJsonObject(v) && typeof v.versionId === "string" ? v.versionId : ""));
          const manifest = readManifest(files[MANIFEST_NAME], parsed.failure ? [...ids, "\u0000"] : ids);
          if (manifest.unsupported) {
            g.unsupported ??= `the package's profile is ${manifest.profile}, which an implementation of ${OG_METHOD} does not implement (P14.1, P3.3)`;
            break;
          }
          g.packages.push({ source: input.source, manifest, files });
          g.copies.push({ source: input.source, values: parsed.values, lineFailure: parsed.failure?.error, fromPackage: { manifest, complete: manifest.completeness === "complete" } });
          for (const [name, bytes] of Object.entries(files)) {
            const r = /^resources\/(z[1-9A-HJ-NP-Za-km-z]+)$/.exec(name);
            if (r) addResource(bytes, `${input.source}#${name}`, r[1]);
            const s = /^(signers\/[0-9a-f]{64}\/)did\.jsonl$/.exec(name);
            if (s) pendingPackagedSigners.push({ dir: s[1], log: bytes, witness: files[`${s[1]}did-witness.json`] });
          }
          break;
        }
        case "signer-history": {
          const entries = parseJsonLines(decoder.decode(input.bytes));
          const did = input.did ?? notes.find((n) => n.source === input.source)?.did ?? stateIdOf(entries[0]);
          if (!did) throw new OgRuleError("P7.17", "SIGNER_HISTORY_DID", "a signer history names no DID");
          g.histories.push({ did, entries, witness: input.witness ? JSON.parse(decoder.decode(input.witness)) as unknown : undefined, source: input.source, obtained: noteFor(did, input.source)?.obtained });
          break;
        }
        case "resource":
          addResource(input.bytes, input.source);
          break;
        default:
          break;
      }
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      g.invalidInputs.push({ source: input.source, error });
    }
  }
  // Packaged signer histories are named by the SHA-256 of the DID (P14.10): match them to the DIDs the log names.
  const named = new Set<string>();
  for (const c of g.copies) for (const v of c.values) for (const did of signerDidsOf(v)) named.add(did);
  for (const p of pendingPackagedSigners) {
    const did = [...named].find((d) => signerDirectory(d) === p.dir);
    if (!did) continue;
    const entries = parseJsonLines(decoder.decode(p.log));
    const note = notes.find((n) => n.did === did && n.source === "package");
    g.histories.push({ did, entries, witness: p.witness ? JSON.parse(decoder.decode(p.witness)) as unknown : undefined, source: note?.source ?? "package", obtained: note?.obtained });
  }
  return g;
}

function stateIdOf(v: JsonValue | undefined): string | undefined {
  return isJsonObject(v) && isJsonObject(v.state) && typeof v.state.id === "string" ? v.state.id : undefined;
}

function signerDidsOf(v: JsonValue): string[] {
  if (!isJsonObject(v) || !isJsonObject(v.state)) return [];
  const out: string[] = [];
  for (const k of ["author", "editor"]) {
    const r = v.state[k];
    if (isJsonObject(r) && typeof r.did === "string") out.push(r.did);
  }
  return out;
}

/** The method value a copy's genesis names, if it names one. */
function genesisMethod(copy: LogCopy): string | undefined {
  const g = copy.values[0];
  return isJsonObject(g) && isJsonObject(g.parameters) && typeof g.parameters.method === "string" ? g.parameters.method : undefined;
}

// ---------------------------------------------------------------------------
// Signer histories

export interface VerifiedLog {
  history: SignerHistory;
  candidate: HistoryCandidate;
}

export interface Histories {
  /**
   * Per signer DID, every supplied log that verifies in full from its genesis (P7.8, P9.33). The evidence is
   * their union (owner decision B, 22 November 2026): a named version is found if any of them holds it. A
   * log that fails anywhere is not here at all.
   */
  byDid: Map<string, VerifiedLog[]>;
}

/**
 * Verify every signer history supplied and keep, for each DID, every one that verifies (P7.8: a newer
 * version in the evidence set wins over an older one a package or host supplies; every verifying log is
 * evidence, whichever order the inputs come in).
 */
export async function verifyHistories(candidates: HistoryCandidate[]): Promise<Histories> {
  const byDid: Histories["byDid"] = new Map();
  for (const c of candidates) {
    const method = signerMethodOf(c.did);
    if (method !== "did:webvh" && method !== "did:vh") continue;
    const history = await verifySignerLog(c.did, c.entries, c.witness);
    if (history.failure || history.versions.length === 0) continue;
    byDid.set(c.did, [...(byDid.get(c.did) ?? []), { history, candidate: c }]);
  }
  return { byDid };
}

/** The supplied logs of a DID that verify, as histories. */
export const signerLogs = (h: Histories, did: string): SignerHistory[] => (h.byDid.get(did) ?? []).map((l) => l.history);

/**
 * The newest version of a signer DID in the evidence set (P7.8) and the log that holds it: the
 * highest-numbered version among the logs that verify, ties broken by the versionId's code-point order,
 * then the log's source and when it was obtained, so the choice never depends on input order.
 */
export function newestSignerLog(h: Histories, did: string): (VerifiedLog & { latest: SignerVersion }) | undefined {
  let best: (VerifiedLog & { latest: SignerVersion }) | undefined;
  for (const l of h.byDid.get(did) ?? []) {
    const latest = latestVersion(l.history);
    if (!latest) continue;
    const better = !best || latest.number > best.latest.number || (latest.number === best.latest.number && (
      byCodePoint(latest.versionId, best.latest.versionId) < 0 || (latest.versionId === best.latest.versionId && (
        byCodePoint(l.candidate.source, best.candidate.source) < 0 ||
        (l.candidate.source === best.candidate.source && byCodePoint(l.candidate.obtained ?? "", best.candidate.obtained ?? "") < 0)))));
    if (better) best = { ...l, latest };
  }
  return best;
}

/** The report's item for a did:vh or did:webvh signer relied on (P7.8, P14.25), from the newest log. */
export function signerLabelOf(h: Histories, did: string, role: "author" | "editor"): SignerLabel | undefined {
  const n = newestSignerLog(h, did);
  if (!n) return undefined;
  return { did, role, latestVersionId: n.latest.versionId, source: n.candidate.source, obtained: n.candidate.obtained ?? null, freshness: n.history.witnessed ? "established" : "not-established" };
}

// ---------------------------------------------------------------------------
// The entry tree

export interface Node {
  entry: OgEntry;
  /** The predecessor's versionId, or null for the genesis entry. */
  parent: string | null;
  index: number;
  sources: string[];
}

export interface Tree {
  nodes: Map<string, Node>;
  children: Map<string | null, string[]>;
  /** Structure failures, by the versionId of the entry that fails (when it has one). */
  structureFailures: Array<{ versionId?: string; parent: string | null; error: OriginalsError }>;
  limitExceeded: boolean;
  scids: Set<string>;
}

export function buildTree(copies: Array<{ source: string; values: JsonValue[]; lineFailure?: OriginalsError }>): Tree {
  const t: Tree = { nodes: new Map(), children: new Map(), structureFailures: [], limitExceeded: false, scids: new Set() };
  for (const copy of copies) {
    const s = checkLogStructure(copy.values);
    if (s.scid) t.scids.add(s.scid);
    s.entries.forEach((entry, index) => {
      const parent = index === 0 ? null : s.entries[index - 1].versionId;
      const known = t.nodes.get(entry.versionId);
      if (known) {
        if (!known.sources.includes(copy.source)) known.sources.push(copy.source);
        return;
      }
      t.nodes.set(entry.versionId, { entry, parent, index, sources: [copy.source] });
      t.children.set(parent, [...(t.children.get(parent) ?? []), entry.versionId]);
    });
    if (s.limitExceeded) t.limitExceeded = true;
    const parent = s.entries.length ? s.entries[s.entries.length - 1].versionId : null;
    if (s.failure && !s.limitExceeded) {
      const raw = copy.values[s.failure.index];
      t.structureFailures.push({ versionId: isJsonObject(raw) && typeof raw.versionId === "string" ? raw.versionId : undefined, parent, error: s.failure.error });
    } else if (copy.lineFailure) {
      t.structureFailures.push({ parent, error: copy.lineFailure });
    }
  }
  for (const list of t.children.values()) list.sort(byLogOrder);
  return t;
}

export const byLogOrder = (a: string, b: string) => versionNumber(a) - versionNumber(b) || (a < b ? -1 : a > b ? 1 : 0);

const ruleOfError = (e: OriginalsError, fallback = "P14.27") => (e.details as { rule?: string } | undefined)?.rule ?? fallback;

/** Rules whose failure is a signer-binding failure, reported as `identity` `failed` (P7.18). */
const BINDING_RULES = new Set(["P5.2", "P5.3", "P5.4", "P5.12", "P5.14", "P14.8"]);

// ---------------------------------------------------------------------------
// Evaluating entries off Bitcoin

type Status = "accepted" | "rejected" | "unchecked" | "conflicting" | "ignored";

export interface Evaluated {
  node: Node;
  status: Status;
  rule?: string;
  identityFailure?: boolean;
  authority?: EntryAuthority;
  endorsed?: boolean;
  /** The signer's key, when the binding was checked. */
  key?: string;
  /** Why the entry is unchecked: the missing signer DID. */
  missingDid?: string;
  /** Set when that DID's history is supplied but does not reach the version the entry names (P7.8). */
  missingVersion?: string;
  ctx: BranchContext;
}

interface EvalOptions {
  /** Treat the first anchoring entry on each branch and every entry after it as unchecked (P7.14). */
  stopAtAnchor: boolean;
  /** Restrict to this entry and its ancestors (P3.2). */
  target?: string;
}

function evaluateTree(tree: Tree, histories: Histories, opts: EvalOptions): Map<string, Evaluated> {
  const out = new Map<string, Evaluated>();
  const allowed = opts.target ? ancestorsOf(tree, opts.target) : undefined;
  const visit = (id: string, ctx: BranchContext | undefined, lastVersions: Map<string, number>, anchored: boolean) => {
    if (allowed && !allowed.has(id)) return;
    const node = tree.nodes.get(id)!;
    const entry = node.entry;
    const context = ctx ?? genesisContext(entry);
    const ev: Evaluated = { node, status: "accepted", ctx: context };
    out.set(id, ev);
    let nextAnchored = anchored;
    try {
      checkTransition(context, entry, node.index);
      if (opts.stopAtAnchor && (anchored || isAnchoringEntry(context, entry))) {
        ev.status = "unchecked";
        nextAnchored = true;
      } else {
        checkSupersedes(tree, node);
        bindSigner(ev, histories, lastVersions);
      }
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      ev.status = "rejected";
      ev.rule = ruleOfError(error);
      ev.identityFailure = BINDING_RULES.has(ev.rule) || error.category === "author-binding";
      return;
    }
    const nextCtx = advance(context, entry);
    const s = stateOf(entry);
    const signer = s.editor ?? s.author;
    const versions = new Map(lastVersions);
    if (ev.status === "accepted") versions.set(identityOf(signer.did), versionNumber(signer.versionId));
    for (const child of tree.children.get(id) ?? []) visit(child, nextCtx, versions, nextAnchored);
  };
  for (const g of tree.children.get(null) ?? []) visit(g, undefined, new Map(), false);
  return out;
}

const identityOf = (did: string) => did;

function ancestorsOf(tree: Tree, id: string): Set<string> {
  const out = new Set<string>();
  let at: string | null = id;
  while (at !== null && tree.nodes.has(at)) {
    out.add(at);
    at = tree.nodes.get(at)!.parent;
  }
  return out;
}

/** P6.9: a named entry in the evidence set must not be an ancestor, and its parent must be one. */
function checkSupersedes(tree: Tree, node: Node): void {
  const named = stateOf(node.entry).supersedes;
  if (!named) return;
  const ancestors = ancestorsOf(tree, node.entry.versionId);
  for (const id of named) {
    const x = tree.nodes.get(id);
    if (!x) continue; // not in the evidence set: no effect
    if (ancestors.has(id) || x.parent === null || !ancestors.has(x.parent)) {
      throw new OgRuleError("P6.9", "SUPERSEDES_INVALID", `superseded entry ${id} is an ancestor, or its parent is not an ancestor, of the superseding entry`);
    }
  }
}

/** P5.2, P5.3, P5.8, P5.6: check the entry's signer against the signer's history in the evidence set. */
function bindSigner(ev: Evaluated, histories: Histories, lastVersions: Map<string, number>): void {
  const s = stateOf(ev.node.entry);
  const ref: SignerRef = s.editor ?? s.author;
  const last = lastVersions.get(identityOf(ref.did));
  if (last !== undefined && versionNumber(ref.versionId) < last) throw new OgRuleError("P5.8", "SIGNER_VERSION_OLDER", "the entry names an older signer DID version than an earlier entry by the same identity");
  const method = signerMethodOf(ref.did)!;
  if (method === "did:btco") {
    ev.status = "unchecked";
    ev.missingDid = ref.did;
    return;
  }
  // P7.8 with the union rule (owner decision B): the named version from any supplied log that verifies.
  const found = lookupVersion(signerLogs(histories, ref.did), ref.versionId);
  if ("missing" in found) {
    ev.status = "unchecked";
    ev.missingDid = ref.did;
    if (found.missing === "version") ev.missingVersion = ref.versionId;
    return;
  }
  if ("mismatch" in found) throw new OgRuleError("P5.3", "SIGNER_VERSION_UNKNOWN", `${ref.did} has no version ${ref.versionId}: ${found.mismatch}`, "author-binding");
  ev.key = checkBinding(ev.node.entry, ref, found.found);
}

/** P7.9, P7.19: the authority label of an accepted entry not inscribed on an anchoring sat. */
function authorityOf(ev: Evaluated, histories: Histories): EntryAuthority {
  const s = stateOf(ev.node.entry);
  const ref = s.editor ?? s.author;
  const latest = newestSignerLog(histories, ref.did)!.latest;
  const authorLatest = s.editor ? newestSignerLog(histories, s.author.did)?.latest : undefined;
  if (latest.deactivated || authorLatest?.deactivated) return "did-deactivated-since";
  if (!listsKey(latest.document, ev.key!)) return "key-removed-since";
  return "current-key";
}

// ---------------------------------------------------------------------------
// The report

/**
 * P14.25 (ccf4a69): an `unsupported` report has `original` and `checkpoint`
 * null, `axes` holding `outcome` only, and empty `entries`, `signers`,
 * and `diagnostics`, and no `bitcoin` member. Why it is unsupported is not a report member;
 * callers get it from `unsupportedReason`.
 */
export function unsupportedReport(evidence: EvidenceSet): Report {
  return {
    type: "OriginalsVerificationReport",
    profile: OG_METHOD,
    original: null,
    checkpoint: null,
    evidence: { inputs: reportInputs(evidence), network: evidence.network ?? null, tip: evidence.tip ?? null, depth: evidence.depth ?? null },
    axes: { outcome: "unsupported" },
    entries: [],
    signers: [],
    diagnostics: [],
  };
}

/** The anchored path (P9.10–P9.36), registered by `bitcoin.ts`. */
export type AnchoredEvaluator = (evidence: EvidenceSet, gathered: Gathered) => Promise<Report>;
let anchoredEvaluator: AnchoredEvaluator | undefined;
export function registerAnchoredEvaluator(f: AnchoredEvaluator): void {
  anchoredEvaluator = f;
}

/** Whether the evidence set holds any Bitcoin input (P7.18 `bitcoin`). */
export const hasBitcoinInput = (e: EvidenceSet) => !!e.network || (e.sats?.length ?? 0) > 0 || e.inputs.some((i) => i.kind === "inscription" || i.kind === "sat-read");

/** Verify an Original from exactly this evidence set (P7.17). */
export async function verifyOriginal(evidence: EvidenceSet): Promise<Report> {
  const gathered = gather(evidence);
  for (const t of evidence.inputs) if (t.kind === "transaction" && anchoredEvaluator) return anchoredEvaluator(evidence, gathered);
  for (const copy of gathered.copies) {
    const m = genesisMethod(copy);
    if (m !== undefined && m !== OG_METHOD) return unsupportedReport(evidence);
  }
  if (gathered.unsupported) return unsupportedReport(evidence);
  if (evidence.inputs.some((i) => i.kind === "inscription" || i.kind === "sat-read") || (evidence.sats?.length ?? 0) > 0) {
    if (!anchoredEvaluator) throw new OriginalsError("unsupported-profile", "BITCOIN_UNAVAILABLE", "the Bitcoin verifier is not loaded");
    return anchoredEvaluator(evidence, gathered);
  }
  return verifyOffChain(evidence, gathered, { bitcoinRead: hasBitcoinInput(evidence) });
}

/**
 * P9.18: a writer's check of its own committed log, through the entry it is
 * about to publish, as a local copy. Every entry, including the anchoring
 * entry, is checked; the result is never `current` and is only the writer's
 * own gate before inscribing (T9-039, T9-040).
 */
export async function verifyLocalCopy(evidence: EvidenceSet): Promise<Report> {
  return verifyOffChain(evidence, gather(evidence), { bitcoinRead: false, localCopy: true });
}

/**
 * Verify from copies of the log alone (P7.10, P7.14): never `current`. A copy
 * holding an anchoring entry is read as a historical checkpoint before it,
 * with `bitcoin` `missing-evidence`.
 */
export interface OffChainOptions {
  bitcoinRead: boolean;
  /** P9.18: the writer's own check of its committed log, through the entry it is about to publish. */
  localCopy?: boolean;
  /**
   * did:btco sats the evidence set reads in full at its tip that hold no anchoring
   * publication of this Original (P9.5): a copy's anchoring entry naming one, and every
   * entry after it, are `ignored`, and the state is valid as of the entry before.
   */
  readSats?: ReadonlySet<string>;
  /**
   * Sats the evidence set reads in full that hold an anchoring publication of this Original that cannot be
   * decided yet (P9.16): not missing evidence, so no `anchoring-sat-not-read` (P7.14), and not `ignored`.
   */
  undecidedSats?: ReadonlySet<string>;
}

export async function verifyOffChain(evidence: EvidenceSet, gathered: Gathered, opts: OffChainOptions): Promise<Report> {
  const histories = await verifyHistories(gathered.histories);
  const tree = buildTree(gathered.copies);
  const scid = evidence.original?.startsWith("did:og:") ? evidence.original.slice("did:og:".length) : undefined;
  const genesisIds = tree.children.get(null) ?? [];
  // No entry at all: nothing binds the did:og, and nothing contradicts it either (P7.18, T7-076; finding F16).
  const noEntries = tree.nodes.size === 0 && tree.structureFailures.length === 0;
  const bound = noEntries || genesisIds.length > 0 && [...tree.scids].every((s) => s === scid) &&
    genesisIds.every((id) => stateOf(tree.nodes.get(id)!.entry).id === evidence.original) &&
    !tree.structureFailures.some((f) => f.parent === null && /^P(14\.28|3\.1)$/.test(ruleOfError(f.error)));
  const anyAnchor = [...tree.nodes.values()].some((n) => stateOf(n.entry).asset?.aliases?.some?.((a: string) => a.startsWith("did:btco:")));
  const stopAtAnchor = anyAnchor && !opts.localCopy;
  const evaluated = bound ? evaluateTree(tree, histories, { stopAtAnchor, target: evidence.checkpoint ?? undefined }) : new Map<string, Evaluated>();

  // A copy's anchoring entry naming a sat read in full without an anchor, and every entry after it, are ignored (P9.5, P7.19).
  if (opts.readSats?.size) {
    for (const ev of evaluated.values()) {
      if (ev.status !== "unchecked") continue;
      const anchorOfBranch = branchAnchor(tree, ev.node);
      if (anchorOfBranch && opts.readSats.has(anchorOfBranch)) ev.status = "ignored";
    }
  }

  // Authority labels and endorsement (P7.19, P7.20).
  for (const ev of evaluated.values()) if (ev.status === "accepted") ev.authority = authorityOf(ev, histories);
  const descendants = (id: string): Evaluated[] => (tree.children.get(id) ?? []).flatMap((c) => (evaluated.has(c) ? [evaluated.get(c)!, ...descendants(c)] : []));
  for (const ev of evaluated.values()) {
    if (ev.status !== "accepted") continue;
    ev.endorsed = descendants(ev.node.entry.versionId).some((d) => d.status === "accepted" && !isEditorEntry(d.node.entry) && d.authority === "current-key");
  }

  // supersedes settles editor-only branches (P6.9).
  for (const ev of evaluated.values()) {
    const named = stateOf(ev.node.entry).supersedes;
    if (!named || ev.status !== "accepted" || !(ev.authority === "current-key" || ev.endorsed)) continue;
    for (const id of named) {
      const x = evaluated.get(id);
      if (!x) continue;
      const branch = [x, ...descendants(id)];
      if (branch.every((b) => b.status !== "accepted" || isEditorEntry(b.node.entry))) for (const b of branch) if (b.status === "accepted" || b.status === "unchecked") b.status = "conflicting";
    }
  }

  // Heads: live entries with no live child.
  const live = (ev: Evaluated) => ev.status === "accepted" || ev.status === "unchecked";
  const liveIds = [...evaluated.values()].filter(live).map((e) => e.node.entry.versionId);
  const heads = liveIds.filter((id) => !(tree.children.get(id) ?? []).some((c) => evaluated.has(c) && live(evaluated.get(c)!)));
  heads.sort(byLogOrder);

  // State and checkpoint.
  let state: Axes["state"];
  let checkpoint: string | null = null;
  // P3.2, P7.18: a target checkpoint the evidence set lacks, or no entry at all, is target-missing.
  let targetMissing: string | undefined;
  if (evidence.checkpoint && !tree.nodes.has(evidence.checkpoint)) {
    state = "none";
    targetMissing = evidence.checkpoint;
  } else if (noEntries) {
    state = "none";
    targetMissing = evidence.original;
  } else if (!bound || heads.length === 0) {
    state = "none";
  } else if (heads.length > 1) {
    state = "conflict";
    checkpoint = commonAncestor(tree, heads); // the fork point, the last entry common to every branch (P7.18, P14.25)
  } else {
    const head = evaluated.get(heads[0])!;
    if (head.status === "unchecked" && stopAtAnchor) {
      // P7.14: at most the entries before the first anchoring entry, as a historical checkpoint.
      let at: Evaluated | undefined = head;
      while (at && at.status === "unchecked") at = at.node.parent ? evaluated.get(at.node.parent) : undefined;
      state = at ? "historical-checkpoint" : "none";
      checkpoint = at?.node.entry.versionId ?? null;
    } else {
      state = "valid-as-of";
      checkpoint = head.node.entry.versionId;
    }
  }

  // Report entries, in log order (P7.19).
  const labels: EntryLabel[] = [];
  const order = [...evaluated.values()].sort((a, b) => byLogOrder(a.node.entry.versionId, b.node.entry.versionId));
  for (const ev of order) {
    const versionId = ev.node.entry.versionId;
    if (ev.status === "accepted") labels.push({ versionId, status: "accepted", authority: ev.authority!, endorsed: ev.endorsed!, ordering: "claimed" });
    else if (ev.status === "rejected") labels.push({ versionId, status: "rejected", rule: ev.rule! });
    else labels.push({ versionId, status: ev.status });
  }
  for (const f of tree.structureFailures) {
    if (f.versionId && !evaluated.has(f.versionId) && (f.parent === null || evaluated.has(f.parent))) labels.push({ versionId: f.versionId, status: "rejected", rule: ruleOfError(f.error) });
  }
  labels.sort((a, b) => byLogOrder(a.versionId, b.versionId));

  // Through the checkpoint: the branch from genesis to it.
  const path = checkpoint ? [...ancestorsOf(tree, checkpoint)].map((id) => evaluated.get(id)!).filter(Boolean).sort((a, b) => a.node.index - b.node.index) : [];

  // Axes.
  const structuralRules = tree.structureFailures.map((f) => f.error);
  const isBinding = (e: OriginalsError) => BINDING_RULES.has(ruleOfError(e)) || e.category === "author-binding";
  const historyInvalid = !bound || structuralRules.some((e) => e.category !== "limit-exceeded" && !isBinding(e)) ||
    [...evaluated.values()].some((e) => e.status === "rejected" && !e.identityFailure);
  const limitExceeded = tree.limitExceeded || structuralRules.some((e) => e.category === "limit-exceeded") ||
    [...histories.byDid.values()].some((logs) => logs.some((h) => h.history.limitExceeded));
  const identityFailed = [...evaluated.values()].some((e) => e.status === "rejected" && e.identityFailure) || structuralRules.some(isBinding);
  const unchecked = [...evaluated.values()].some((e) => e.status === "unchecked");
  const history: Axes["history"] = historyInvalid ? "invalid" : limitExceeded ? "limit-exceeded" : "valid";
  const identity: Axes["identity"] = identityFailed ? "failed" : unchecked ? "incomplete" : "complete";
  const authority: Axes["authority"] = path.some((e) => e.status === "accepted" && e.authority !== "current-key" && !e.endorsed) ? "historical" : "current";

  // Diagnostics (P14.25) and availability (P7.4): every resource version through the checkpoint.
  const diagnostics: Diagnostic[] = [];
  let versions = 0;
  let unavailable = 0;
  for (const ev of path) {
    for (const t of stateOf(ev.node.entry).transitions) {
      versions++;
      const bytes = gathered.resources.get(t.to);
      const desc = stateOf(ev.node.entry).asset.resource;
      const versionId = ev.node.entry.versionId;
      if (bytes && bytes.length === desc.size) continue;
      unavailable++;
      const mismatched = gathered.mismatched.some((m) => m.digest === t.to);
      diagnostics.push(mismatched
        ? { code: "resource-mismatch", rule: "P7.4", item: { kind: "resource", id: t.to, versionId }, reason: "The bytes supplied for this resource version do not match its descriptor." }
        : { code: "resource-missing", rule: "P7.4", item: { kind: "resource", id: t.to, versionId }, reason: "The evidence set does not hold the bytes of this resource version." });
    }
  }
  const availability: Axes["availability"] = unavailable === 0 ? "complete" : unavailable === versions ? "none" : "partial";
  const satsNamed = new Set<string>();
  for (const ev of evaluated.values()) {
    if (ev.status === "unchecked") diagnostics.push({ code: "proof-unchecked", rule: "P7.19", item: { kind: "entry", id: ev.node.entry.versionId }, reason: "The entry's proof could not be checked: the evidence it needs is not in the evidence set." });
    if (ev.status === "rejected") diagnostics.push({ code: "entry-rejected", rule: ev.rule!, item: { kind: "entry", id: ev.node.entry.versionId }, reason: `The entry fails ${ev.rule}.` });
    if (!ev.missingDid) continue;
    if (signerMethodOf(ev.missingDid) === "did:btco") satsNamed.add(ev.missingDid);
    else if (ev.missingVersion) diagnostics.push({ code: "signer-version-missing", rule: "P7.8", item: { kind: "signer", id: ev.missingDid, versionId: ev.missingVersion }, reason: "The supplied signer history does not reach the version the entry names." });
    else diagnostics.push({ code: "signer-history-missing", rule: "P5.6", item: { kind: "signer", id: ev.missingDid }, reason: "The signer DID's history is not in the evidence set." });
  }
  for (const f of tree.structureFailures) {
    if (f.versionId && !evaluated.has(f.versionId) && (f.parent === null || evaluated.has(f.parent))) diagnostics.push({ code: "entry-rejected", rule: ruleOfError(f.error), item: { kind: "entry", id: f.versionId }, reason: f.error.message });
  }
  for (const did of satsNamed) diagnostics.push({ code: "signer-sat-not-read", rule: "P9.35", item: { kind: "sat", id: did }, reason: "The did:btco signer's sat is not read in full in the evidence set." });
  const anchorAliases = new Set<string>();
  for (const ev of evaluated.values()) if (ev.status === "unchecked") {
    const a = branchAnchor(tree, ev.node);
    if (a) anchorAliases.add(a);
  }
  for (const a of anchorAliases) if (!opts.readSats?.has(a) && !opts.undecidedSats?.has(a)) diagnostics.push({ code: "anchoring-sat-not-read", rule: "P7.14", item: { kind: "sat", id: a }, reason: "The log names this anchoring sat, and the evidence set does not read it in full." });
  for (const i of gathered.invalidInputs) diagnostics.push({ code: "input-unusable", rule: "P7.17", item: { kind: "input", id: i.source }, reason: i.error.message });

  // Signers relied on (P7.8).
  const signers: SignerLabel[] = [];
  const relied = new Map<string, "author" | "editor">();
  for (const ev of order) {
    if (!ev.key) continue;
    const s = stateOf(ev.node.entry);
    const did = (s.editor ?? s.author).did;
    if (!relied.has(did)) relied.set(did, s.editor ? "editor" : "author");
  }
  for (const [did, role] of relied) signers.push(signerLabelOf(histories, did, role)!);

  if (targetMissing) diagnostics.push({ code: "target-missing", rule: "P3.2", item: { kind: "entry", id: targetMissing }, reason: "The evidence set does not hold the target checkpoint, or holds no entry." });
  // Offline (P7.21): derived from the diagnostics.
  const sorted = sortDiagnostics(diagnostics);
  const offline = offlineFrom(sorted);

  const anchorUnread = sorted.some((d) => d.code === "anchoring-sat-not-read");
  const bitcoin: Axes["bitcoin"] = anchorUnread ? "missing-evidence" : opts.bitcoinRead || (anyAnchor && opts.readSats?.size) ? "not-anchored" : "not-read";
  const rest: Omit<Axes, "outcome"> = { binding: bound ? "bound" : "unbound", history, identity, authority, state, availability, offline, bitcoin };
  const report: Report = {
    type: "OriginalsVerificationReport",
    profile: OG_METHOD,
    original: evidence.original,
    checkpoint,
    evidence: { inputs: reportInputs(evidence), network: evidence.network ?? null, tip: evidence.tip ?? null, depth: evidence.depth ?? null },
    // P7.18: `state` `none` for a missing target is `incomplete`, unless something failed.
    axes: { outcome: targetMissing && outcomeOf(rest) === "verified" ? "incomplete" : outcomeOf(rest), ...rest },
    entries: labels,
    signers,
    diagnostics: sorted,
  };
  if (opts.localCopy) report.reason = "local copy (P9.18): the writer's own check before it publishes; unverified on Bitcoin, never current, and never a report for anyone else";
  return report;
}

/** The did:btco alias named by the first anchoring entry on a node's branch, at or before it (P9.10). */
function branchAnchor(tree: Tree, node: Node): string | undefined {
  let found: string | undefined;
  let at: Node | undefined = node;
  while (at) {
    const a = (stateOf(at.entry).asset?.aliases as string[] | undefined)?.find((x) => x.startsWith("did:btco:"));
    if (a) found = a;
    at = at.parent ? tree.nodes.get(at.parent) : undefined;
  }
  return found;
}

function commonAncestor(tree: Tree, heads: string[]): string | null {
  const sets = heads.map((h) => ancestorsOf(tree, h));
  let best: string | null = null;
  for (const id of sets[0]) if (sets.every((s) => s.has(id)) && (best === null || versionNumber(id) > versionNumber(best))) best = id;
  return best;
}

export { isDeactivation };
export type { EvidenceInput };
