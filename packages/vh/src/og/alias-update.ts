/**
 * Adding a did:webvh alias to an existing did:og Original from logs signed
 * elsewhere (P3.6, P3.9, P14.5, P14.29, P5.3, P5.8, P9.10), checked before
 * anything is hosted.
 *
 * Two signed inputs:
 * - the next did:og entry, signed by the Original's existing author key, that
 *   lists the did:webvh alias;
 * - the alias's own did:webvh log, signed by its own update key, whose DID
 *   document lists the did:og in `alsoKnownAs` (P3.6).
 *
 * The check takes no key, signs nothing and reads nothing from the network.
 * Every check runs strictly and any failure rejects. Besides the spec's rules, two
 * checks are policy for this operation, not spec rules: the entry changes
 * nothing but the alias list (`alias-only`), and the alias log is controlled
 * by an update key the author identity does not use (`separate-signer`).
 *
 * A `verified` result is not a hosted alias. Nothing is served at the
 * alias's URL until a host publishes the log and the package (P14.11), and
 * until then no one else can resolve it.
 */
import { parseJsonLines, type JsonObject, type JsonValue } from "../json/index.js";
import { parseDidWebvh } from "../webvh/index.js";
import { checkAlias } from "./hosted.js";
import { readInscription } from "./inscription.js";
import { checkChainLink, parseLogFile, prepareNext, serializeLog, type OgEntry, type UnsignedEntry } from "./log.js";
import type { EvidenceSet, Report } from "./report.js";
import { stateOf, type OgState } from "./state.js";
import { buildTree, gatherEvidence, verifyOriginal, type Tree } from "./verify.js";

/** Bounds on the two supplied files: an entry is at most 64 KiB (P14.13); an alias log is read up to 1 MiB. */
export const ALIAS_UPDATE_LIMITS = Object.freeze({ entryBytes: 65_536 + 1, aliasLogBytes: 1024 * 1024 });

export type AliasUpdateCheckId =
  | "imported" | "entry" | "extends-checkpoint" | "alias-only" | "signed-by-author"
  | "media-unchanged" | "alias-log" | "backlink" | "links-agree" | "separate-signer";

export interface AliasUpdateCheck { id: AliasUpdateCheckId; ok: boolean; detail?: string }

export interface AliasUpdateReport {
  /** `verified` only when every check passed. Never means hosted or resolvable. */
  status: "verified" | "rejected";
  /** Always false: this check publishes nothing (P14.11). */
  hosted: false;
  original: string;
  author: string | null;
  /** The did:webvh alias the entry proposes, when it adds exactly one. */
  alias: string | null;
  /** The alias's host and path, from the DID (`example.com/film`). */
  aliasHost: string | null;
  checkpointBefore: string | null;
  checkpointAfter: string | null;
  resource: { digest: string; mediaType: string; size: number } | null;
  checks: AliasUpdateCheck[];
  /** The failed checks' details, in order. */
  reasons: string[];
  /** The verification report of the history with the entry appended, when it was built. */
  report?: Report;
}

export interface AliasUpdateOptions {
  /** Require the alias log's update keys to differ from the author identity's (default true; policy, not a spec rule). */
  requireSeparateSigner?: boolean;
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const text = (v: string | Uint8Array) => (typeof v === "string" ? v : dec.decode(v));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.+$/, "");
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

/** checkAlias's reasons when the alias log itself verified (hosted.ts). */
const NO_BACKLINK = "the alias's DID document does not list the did:og";
const NOT_LISTED = "the Original's state does not list the alias";

/** The branch from genesis to `id`, oldest first. */
function chainTo(tree: Tree, id: string): OgEntry[] {
  const out: OgEntry[] = [];
  for (let at: string | null = id; at; at = tree.nodes.get(at)?.parent ?? null) {
    const node = tree.nodes.get(at);
    if (!node) break;
    out.unshift(node.entry);
  }
  return out;
}

/**
 * The evidence's history as log copies: its off-chain copies (logs, packages)
 * and, for anchored evidence, the entries inscribed on the sat, oldest first.
 */
function historyCopies(evidence: EvidenceSet, gathered: ReturnType<typeof gatherEvidence>) {
  const inscribed: JsonValue[] = [];
  const seen = new Set<string>();
  for (const i of evidence.inputs) {
    if (i.kind !== "inscription") continue;
    const r = readInscription(i.bytes);
    if (r.kind !== "originals") continue;
    for (const e of r.metadata.entries as OgEntry[]) if (!seen.has(e.versionId)) { seen.add(e.versionId); inscribed.push(e); }
  }
  return inscribed.length ? [...gathered.copies, { source: "inscriptions", values: inscribed }] : gathered.copies;
}

/** Update keys a did:webvh / did:vh log names in any of its entries. */
function updateKeysOf(entries: readonly JsonValue[]): string[] {
  const keys = new Set<string>();
  for (const e of entries) {
    const p = (e as { parameters?: { updateKeys?: unknown } } | null)?.parameters;
    if (Array.isArray(p?.updateKeys)) for (const k of p.updateKeys) if (typeof k === "string") keys.add(k);
  }
  return [...keys];
}

/**
 * The unsigned entry that adds `alias` to the Original after `checkpoint`,
 * changing nothing else (P14.29, P14.5): operation `update`, no transition,
 * the same author reference. The existing author key signs it with `signEntry`.
 */
export function prepareAliasEntry(checkpoint: OgEntry, alias: string, versionTime: string): UnsignedEntry {
  parseDidWebvh(alias);
  const prior = stateOf(checkpoint);
  if (prior.asset.aliases.includes(alias)) throw new Error(`${alias} is already an alias of this Original`);
  const { editor: _e, supersedes: _s, ...rest } = prior;
  const state = { ...rest, operation: "update", transitions: [], asset: { ...prior.asset, aliases: [...prior.asset.aliases, alias] } };
  return prepareNext(checkpoint, { versionTime, parameters: {}, state: state as unknown as JsonObject });
}

/**
 * The entry an alias entry has to extend: the evidence's checkpoint, when the
 * evidence verifies, every entry in it is accepted, the checkpoint is the single
 * head of its history (anything else would fork it, P2.1, P4.5), and no entry
 * anchors it (after anchoring no entry adds a did:webvh alias, P9.10).
 */
export async function aliasCheckpoint(evidence: EvidenceSet): Promise<{ entry: OgEntry | null; report: Report; chain: OgEntry[]; problem: string | null }> {
  const report = await verifyOriginal(evidence);
  const tree = buildTree(historyCopies(evidence, gatherEvidence(evidence)));
  const fail = (problem: string) => ({ entry: null, report, chain: [], problem });
  if (report.axes.outcome === "invalid" || report.axes.outcome === "unsupported" || !report.checkpoint) return fail(`The imported evidence does not verify (${report.axes.outcome})`);
  const node = tree.nodes.get(report.checkpoint);
  const anchored = [...tree.nodes.values()].some((n) => stateOf(n.entry).asset.aliases.some((a) => a.startsWith("did:btco:")));
  if (anchored) return fail("The Original is anchored, and after anchoring no entry adds a did:webvh alias (P9.10)");
  if (!node || (tree.children.get(report.checkpoint)?.length ?? 0) > 0 || report.entries.some((e) => e.status !== "accepted")) {
    return fail("The imported checkpoint is not the single head of an accepted history, so nothing can extend it exactly (P2.1, P4.5)");
  }
  return { entry: node.entry, report, chain: chainTo(tree, report.checkpoint), problem: null };
}

/**
 * Check a proposed did:webvh alias for an imported did:og Original. `evidence`
 * is the imported evidence set (a package, log copies, or both); `entry` is
 * exactly one signed log line; `aliasLog` is the alias's `did.jsonl`.
 */
export async function checkAliasUpdate(input: { evidence: EvidenceSet; entry: string | Uint8Array; aliasLog: string | Uint8Array }, options: AliasUpdateOptions = {}): Promise<AliasUpdateReport> {
  const { evidence } = input;
  const checks: AliasUpdateCheck[] = [];
  const pass = (id: AliasUpdateCheckId, detail?: string) => { checks.push({ id, ok: true, ...(detail ? { detail } : {}) }); };
  const fail = (id: AliasUpdateCheckId, detail: string) => { checks.push({ id, ok: false, detail }); };
  const done = (p: Partial<AliasUpdateReport>): AliasUpdateReport => {
    const reasons = checks.filter((c) => !c.ok).map((c) => c.detail ?? c.id);
    const complete = checks.some((c) => c.id === "links-agree" && c.ok);
    return {
      status: reasons.length === 0 && complete ? "verified" : "rejected", hosted: false,
      original: evidence.original, author: null, alias: null, aliasHost: null, checkpointBefore: null, checkpointAfter: null, resource: null,
      ...p, checks, reasons,
    };
  };

  // 1. The imported evidence verifies, holds one unanchored history, and its checkpoint is that history's head.
  const gathered = gatherEvidence(evidence);
  const cp = await aliasCheckpoint(evidence);
  const checkpointBefore = cp.report.checkpoint;
  const before = cp.report;
  if (!cp.entry) {
    fail("imported", cp.problem!);
    return done({ checkpointBefore });
  }
  pass("imported", checkpointBefore!);
  const chain = cp.chain;
  const head = { entry: cp.entry };
  const prior = stateOf(head.entry);
  const facts = { checkpointBefore, author: prior.author.did, resource: { ...prior.asset.resource } };

  // 2. Exactly one well-formed entry line (P14.2).
  const raw = text(input.entry);
  if (raw.length > ALIAS_UPDATE_LIMITS.entryBytes) { fail("entry", "The signed entry is larger than any did:og entry can be (P14.13)"); return done(facts); }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length !== 1) { fail("entry", `Expected exactly one signed entry line; found ${lines.length}`); return done(facts); }
  const parsed = parseLogFile(`${lines[0]}\n`);
  if (parsed.failure || parsed.values.length !== 1) { fail("entry", `The signed entry is not a did:og entry: ${parsed.failure ? message(parsed.failure.error) : "unreadable"}`); return done(facts); }
  const next = parsed.values[0] as OgEntry;
  pass("entry", next.versionId);

  // 3. It extends the imported checkpoint exactly (P14.29, P14.27): no stale parent, no new genesis.
  try {
    checkChainLink(next, chain.length, head.entry, chain[0].parameters.scid as string);
    pass("extends-checkpoint", `${checkpointBefore} → ${next.versionId}`);
  } catch (e) {
    fail("extends-checkpoint", `The signed entry does not extend the imported checkpoint ${checkpointBefore} (stale, or from another history): ${message(e)}`);
    return done(facts);
  }

  // 4. Alias only (policy): same Original, author and media; one added did:webvh alias, none removed.
  let state: OgState;
  try { state = stateOf(next); } catch (e) { fail("alias-only", `The entry's state is unreadable: ${message(e)}`); return done(facts); }
  const added = (Array.isArray(state.asset?.aliases) ? state.asset.aliases : []).filter((a) => !prior.asset.aliases.includes(a));
  const alias = added.length === 1 && added[0].startsWith("did:webvh:") ? added[0] : null;
  let aliasHost: string | null = null;
  if (alias) { try { const p = parseDidWebvh(alias); aliasHost = [p.host + (p.port ? `:${p.port}` : ""), ...p.path].join("/"); } catch { /* reported below */ } }
  const diffs: string[] = [];
  if (state.id !== evidence.original) diffs.push("it names a different Original");
  if (!same(state.author, prior.author)) diffs.push("it changes the author");
  if ("editor" in state) diffs.push("it is an editor entry, not the author's");
  if (state.operation !== "update") diffs.push(`its operation is ${state.operation}, not update`);
  if (state.transitions?.length) diffs.push("it records a media change");
  if (!same(state.asset?.resource, prior.asset.resource)) diffs.push("it changes the media");
  const { aliases: _a, resource: _r, ...now } = state.asset ?? ({} as OgState["asset"]);
  const { aliases: _b, resource: _q, ...was } = prior.asset;
  if (!same(now, was)) diffs.push("it changes the name, metadata or other fields");
  if (prior.asset.aliases.some((a) => !state.asset?.aliases?.includes(a))) diffs.push("it removes an existing alias");
  if (!alias) diffs.push(added.length === 0 ? "it adds no alias" : "it must add exactly one did:webvh alias");
  else if (!aliasHost) diffs.push(`${alias} is not a valid did:webvh`);
  if (Object.keys(next.parameters ?? {}).length) diffs.push("it changes the log's parameters");
  if (state.supersedes) diffs.push("it supersedes other entries");
  if (alias && prior.asset.aliases.some((a) => a.startsWith("did:btco:"))) diffs.push("the Original is anchored, and after anchoring no entry adds a did:webvh alias (P9.10)");
  if (diffs.length) fail("alias-only", `The signed entry is not an alias-only update: ${diffs.join("; ")}`);
  else pass("alias-only", alias!);

  // 5. The full verifier on the history with the entry appended: the author's current key signed it (P5.3, P5.8, P9.10).
  const candidate: EvidenceSet = {
    ...evidence,
    checkpoint: next.versionId,
    inputs: [...evidence.inputs, { kind: "log", source: "alias-update:candidate", bytes: enc.encode(serializeLog([...chain, next])) }],
  };
  const after = await verifyOriginal(candidate);
  const label = after.entries.find((e) => e.versionId === next.versionId);
  const proofVm = (next.proof?.[0] as { verificationMethod?: string } | undefined)?.verificationMethod;
  if (!label || label.status !== "accepted") {
    const rule = label && "rule" in label ? ` (${label.rule})` : "";
    const why = after.diagnostics.find((d) => d.item.versionId === next.versionId || d.item.id === next.versionId)?.reason?.replace(/\.+$/, "");
    const status = label ? label.status : "not found in the extended history";
    fail("signed-by-author", `The did:og verifier did not accept the signed entry${rule}: ${why ?? `it is ${status}`}`);
  } else if (label.authority !== "current-key") {
    fail("signed-by-author", `The entry's key is not the author's current key (${label.authority})`);
  } else if (proofVm !== prior.author.verificationMethod || after.axes.outcome === "invalid" || after.checkpoint !== next.versionId) {
    fail("signed-by-author", "The entry was not signed by the Original's authorized key, or the extended history does not settle on it");
  } else {
    pass("signed-by-author", proofVm);
  }

  // 6. Media bytes: nothing supplied mismatches its digest, and the current version's bytes are present (P4.3, P7.4).
  const mismatched = [
    ...gathered.mismatched.map((m) => m.digest),
    ...before.diagnostics.filter((d) => d.code === "resource-mismatch").map((d) => d.item.id),
    // An input whose bytes do not match the digest it states (P7.17) is tampered, not merely absent.
    ...gathered.invalidInputs.filter((i) => i.error.code === "INPUT_DIGEST").map((i) => i.source),
  ];
  if (mismatched.length) fail("media-unchanged", `Media bytes do not match their signed digests: ${[...new Set(mismatched)].join(", ")}`);
  else if (!gathered.resources.has(prior.asset.resource.digest)) fail("media-unchanged", `The evidence does not carry the current media bytes (${prior.asset.resource.digest})`);
  else pass("media-unchanged", prior.asset.resource.digest);

  // 7–9. The alias log verifies, points back (alsoKnownAs, P3.6), and both links name each other.
  const aliasText = text(input.aliasLog);
  const base = { ...facts, alias, aliasHost, checkpointAfter: next.versionId, report: after };
  if (aliasText.length > ALIAS_UPDATE_LIMITS.aliasLogBytes) { fail("alias-log", "The alias log is larger than this check reads"); return done(base); }
  const link = await checkAlias(aliasText, evidence.original, next);
  const logVerified = !!link.alias && (link.pointsToOriginal || link.reason === NO_BACKLINK || link.reason === NOT_LISTED);
  if (!logVerified) fail("alias-log", `The alias log does not verify: ${link.reason ?? "it names no DID"}`);
  else {
    pass("alias-log", link.alias);
    if (link.pointsToOriginal) pass("backlink", evidence.original);
    else fail("backlink", `The alias's DID document does not list ${evidence.original} in alsoKnownAs (P3.6)`);
  }
  if (link.confirmed && link.alias === alias) pass("links-agree", `${evidence.original} ⇄ ${alias}`);
  else if (link.alias && alias && link.alias !== alias) fail("links-agree", `The entry proposes ${alias}, but the alias log is for ${link.alias}`);
  else fail("links-agree", "The did:og entry and the alias log do not name each other (P3.6)");

  // 10. Separate signer (policy): the alias is its own identity, not the author DID, with its own update key.
  if (options.requireSeparateSigner !== false) {
    const authorKeys = new Set(gathered.histories.filter((h) => h.did === prior.author.did).flatMap((h) => updateKeysOf(h.entries)));
    let aliasKeys: string[] = [];
    try { aliasKeys = updateKeysOf(parseJsonLines(aliasText)); } catch { /* alias-log reports it */ }
    if (alias && alias === prior.author.did) fail("separate-signer", "The proposed alias is the author's own DID");
    else if (aliasKeys.some((k) => authorKeys.has(k))) fail("separate-signer", "The alias log is controlled by an update key of the author identity; it needs its own signer");
    else if (aliasKeys.length) pass("separate-signer");
    else fail("separate-signer", "The alias log names no update key");
  }

  return done(base);
}
