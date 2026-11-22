/**
 * did:og on Bitcoin (P9.10–P9.36): publications on the anchoring sat, read
 * as ord 0.29.x reads them (P9.31), in chain order (block height, transaction
 * index, inscription index; P9.13), at one tip. The anchoring publication
 * carries the log from genesis through the anchoring entry with the signer
 * histories its entries rely on (P9.17, P9.33); each later publication one
 * entry. Each entry is decided by the first matching row of the P9.15 table.
 * A sat holds at most one Original (P9.34); the first valid anchor in chain
 * order wins (P9.16).
 */
import { isJsonObject, type JsonObject } from "../json/index.js";
import { decodeCbor } from "../originals/cbor.js";
import { checkChainLink, checkEntryShape, checkParameters, checkStrictValue, parseLogFile, resourceDigest, versionNumber, type OgEntry } from "./log.js";
import { envelopesInWitness, parseEnvelope, parseTransaction, readInscription, type InscriptionReading, type SignerHistoryItem } from "./inscription.js";
import { changeRecords, offlineFrom, outcomeOf, reportInputs, sortDiagnostics, type Axes, type ChangeRecord, type Diagnostic, type EntryLabel, type EvidenceSet, type InscriptionRead, type Report, type SatRead, type SignerLabel } from "./report.js";
import { OG_LIMITS, OG_METHOD, OgRuleError, reject } from "./rules.js";
import { checkBinding, listsKey, lookupVersion, verifySignerLog, type SignerHistory, type SignerVersion } from "./signers.js";
import { advance, btcoDid, checkTransition, genesisContext, isEditorEntry, parseBtco, signerMethodOf, stateOf, type BitcoinNetwork, type BranchContext } from "./state.js";
import { registerAnchoredEvaluator, unsupportedReport, verifyOffChain, type Gathered } from "./verify.js";

// ---------------------------------------------------------------------------
// Chain order and sat reads

export interface Position {
  height: number;
  txIndex: number;
  inscriptionIndex: number;
}

/** P9.13: block height, then transaction index, then inscription index. */
export const chainOrder = (a: Position, b: Position) => a.height - b.height || a.txIndex - b.txIndex || a.inscriptionIndex - b.inscriptionIndex;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface MergedSat {
  sat: string;
  network: BitcoinNetwork;
  /** Confirmed inscriptions every index agrees on, in chain order. */
  inscriptions: InscriptionRead[];
  /** Observed with fewer confirmations than the depth: never part of the accepted log (P9.5). */
  observed: InscriptionRead[];
  complete: boolean;
  /** The indexes disagree on the list, its order or the holder (P9.10, P9.31). */
  disputed: boolean;
  holder: string | null;
  indexes: string[];
}

/** Merge one sat's reads by every index used (P9.10, P9.31): they must agree exactly, at one tip. */
export function mergeSat(sat: string, reads: SatRead[], depth: number): MergedSat {
  const btco = parseBtco(sat);
  if (!btco) reject("P9.10", "BTCO_FORM", `${sat} is not a did:btco`);
  const satNumber = btco.sat.toString();
  const ordered = (r: SatRead) => r.inscriptions.filter((i) => i.sat === satNumber).sort(chainOrder);
  const first = ordered(reads[0]);
  let disputed = false;
  for (const r of reads.slice(1)) {
    const o = ordered(r);
    if (o.length !== first.length || o.some((x, k) => x.id !== first[k].id || chainOrder(x, first[k]) !== 0 || !sameBytes(x.envelope, first[k].envelope)) || (r.holder ?? null) !== (reads[0].holder ?? null)) disputed = true;
  }
  return {
    sat, network: btco.network,
    inscriptions: first.filter((i) => i.confirmations >= depth),
    observed: first.filter((i) => i.confirmations < depth),
    complete: reads.every((r) => r.complete),
    disputed,
    holder: reads[0].holder ?? null,
    indexes: reads.map((r) => r.index),
  };
}

// ---------------------------------------------------------------------------
// did:btco signer histories (P5.13)

/** A did:btco signer's versions from its own sat: inscriptions whose own metadata is a CBOR DID document for it. */
export function btcoSignerHistory(did: string, sat: MergedSat): SignerHistory & { positions: Position[]; endsBefore?: Position } {
  const versions: SignerVersion[] = [];
  const positions: Position[] = [];
  let endsBefore: Position | undefined;
  for (const i of sat.inscriptions) {
    // Metadata not read could hold a version: the history ends before it, never skips it (P5.13).
    if (i.unread) {
      endsBefore = i;
      break;
    }
    const r = readInscription(i.envelope);
    const meta = r.kind === "other" ? r.metadata : null;
    if (!meta) continue;
    let doc;
    try {
      doc = decodeCbor(meta);
    } catch {
      continue;
    }
    if (!isJsonObject(doc) || doc.id !== did) continue;
    const deactivated = doc.deactivated === true;
    const prev = versions[versions.length - 1];
    versions.push({ versionId: i.id, number: versions.length + 1, document: deactivated && prev ? prev.document : doc, deactivated, updateKeys: [], inscription: i.id });
    positions.push(i);
    if (deactivated) break; // terminal (P5.13)
  }
  return { did, method: "did:btco", versions, limitExceeded: versions.length > OG_LIMITS.signerVersions, witnessed: false, positions, endsBefore };
}

// ---------------------------------------------------------------------------
// Publications (P9.32)

interface Part {
  read: InscriptionRead;
  reading: Extract<InscriptionReading, { kind: "originals" }>;
}

export interface Publication {
  parts: InscriptionRead[];
  /** Readings of its parts, when every part read as an Originals inscription. */
  readings: Part[];
  /** Set when the publication is rejected as a whole before its entries are judged. */
  invalid?: { rule: string; reason: string };
  final: InscriptionRead;
}

/** Group a sat's Originals inscriptions into publications in chain order (P9.32). */
export function publicationsOf(sat: MergedSat): { publications: Publication[]; ignored: InscriptionRead[] } {
  const publications: Publication[] = [];
  const ignored: InscriptionRead[] = [];
  let open: Part[] = [];
  const close = (invalid?: Publication["invalid"]) => {
    if (open.length) publications.push({ parts: open.map((p) => p.read), readings: open, final: open[open.length - 1].read, invalid });
    open = [];
  };
  for (const read of sat.inscriptions) {
    const reading = readInscription(read.envelope);
    if (reading.kind === "other") {
      ignored.push(read); // not an Originals inscription; does not interrupt a publication (P9.31, P9.32)
      continue;
    }
    if (reading.kind === "invalid") {
      if (open.length) close({ rule: "P9.32", reason: "interrupted by another Originals inscription" });
      publications.push({ parts: [read], readings: [], final: read, invalid: { rule: reading.rule, reason: reading.reason } });
      continue;
    }
    const part = reading.metadata.part;
    if (open.length) {
      const [, n] = open[0].reading.metadata.part!;
      if (part && part[1] === n && part[0] === open.length + 1) {
        open.push({ read, reading });
        if (part[0] === n) close();
        continue;
      }
      close({ rule: "P9.32", reason: "interrupted by another Originals inscription" });
    }
    if (!part) publications.push({ parts: [read], readings: [{ read, reading }], final: read });
    else if (part[0] === 1) open = [{ read, reading }];
    else publications.push({ parts: [read], readings: [{ read, reading }], final: read, invalid: { rule: "P9.32", reason: "a part that does not follow part 1" } });
  }
  // A publication whose final part has not appeared changes nothing (P9.32).
  return { publications, ignored };
}

// ---------------------------------------------------------------------------
// Judging publications

interface SignerState {
  /** Cumulative inscribed log entries for each did:vh / did:webvh signer (P9.33). */
  logs: Map<string, { entries: JsonObject[]; witness: unknown[]; history: SignerHistory; source: string }>;
}

interface Head {
  entry: OgEntry;
  ctx: BranchContext;
  index: number;
  lastVersions: Map<string, number>;
  position: Position;
}

type EntryResult = { status: "accepted" } | { status: "rejected"; rule: string; identity?: boolean } | { status: "unverifiable"; did: string; versionId: string } | { status: "incomplete"; did: string };

interface Judged {
  ok: boolean;
  rule?: string;
  identity?: boolean;
  entries: OgEntry[];
  results: EntryResult[];
  signers: SignerState["logs"];
  unverifiable?: { did: string; versionId: string };
  incomplete?: string[];
  fullBody?: Uint8Array;
  original?: string;
}

const clone = (s: SignerState["logs"]) => new Map([...s].map(([k, v]) => [k, { ...v, entries: [...v.entries], witness: [...v.witness] }]));

/** P9.17, P9.32: the shape of a publication's parts and its body against its last entry's `body`. */
function checkPublicationShape(pub: Publication, last: OgEntry): Uint8Array | undefined {
  if (pub.readings.length > OG_LIMITS.publicationParts) reject("P9.32", "TOO_MANY_PARTS", "a publication has at most 16 inscriptions (P14.13)");
  pub.readings.forEach((p, k) => {
    const isFinal = k === pub.readings.length - 1;
    if (!isFinal && (p.reading.body !== null || p.reading.contentType !== null)) reject("P9.32", "BODY_NOT_FINAL", "only the final part has a body or content type");
    if (p.reading.metadataBytes + (p.reading.body?.length ?? 0) > OG_LIMITS.inscriptionBytes) reject("P9.17", "INSCRIPTION_TOO_LARGE", "an inscription's metadata and body exceed 350,000 bytes");
  });
  const { body, contentType } = pub.readings[pub.readings.length - 1].reading;
  const asset = stateOf(last).asset;
  const match = (d: { mediaType: string; size: number; digest: string }) => body !== null && body.length === d.size && resourceDigest(body) === d.digest && contentType === d.mediaType;
  if (asset.body === "preview") {
    if (!asset.preview || !match(asset.preview)) reject("P9.17", "BODY_MISMATCH", "the body is not the preview the last entry names");
    return undefined;
  }
  if (asset.body === "full") {
    if (!match(asset.resource)) reject("P9.17", "BODY_MISMATCH", "the body is not the full version the last entry names");
    return body!;
  }
  if (body !== null || contentType !== null) reject("P9.17", "BODY_MISMATCH", "body none: no body and no content type");
  return undefined;
}

/** P9.33: add a publication's signer histories, continuing what is inscribed, and verify each from genesis. */
async function addSignerHistories(items: SignerHistoryItem[], signers: SignerState["logs"], source: string): Promise<void> {
  for (const item of items) {
    const known = signers.get(item.did);
    const prior = known?.entries ?? [];
    const first = item.log[0];
    const n = typeof first.versionId === "string" ? versionNumber(first.versionId) : NaN;
    if (n !== prior.length + 1) reject("P9.33", "SIGNER_HISTORY_GAP", `${item.did}'s inscribed history does not continue from version ${prior.length}`);
    const entries = [...prior, ...item.log];
    for (const e of entries) checkStrictValue(e);
    if (entries.length > OG_LIMITS.signerVersions) reject("P14.13", "SIGNER_HISTORY_LIMIT", "an inscribed signer history above 1,000 versions", "limit-exceeded");
    if (prior.length && known!.history.versions[known!.history.versions.length - 1].deactivated) reject("P9.33", "SIGNER_HISTORY_AFTER_DEACTIVATION", "an inscribed history continues after a deactivated version");
    const witness = [...(known?.witness ?? []), ...(item.witness ?? [])];
    const history = await verifySignerLog(item.did, entries, witness.length ? witness : undefined);
    if (history.failure || history.versions.length !== entries.length) reject("P9.33", "SIGNER_HISTORY_INVALID", `${item.did}'s inscribed history does not verify under its method: ${history.failure?.message ?? ""}`);
    signers.set(item.did, { entries, witness, history, source });
  }
}

interface JudgeContext {
  original: string;
  sat: string;
  network: BitcoinNetwork;
  btco: Map<string, ReturnType<typeof btcoSignerHistory> & { complete: boolean }>;
}

/**
 * P9.35: a did:btco signer's sat is read in full for an inscription when the
 * evidence set holds its complete list at the tip and every inscription on it
 * before the candidate was read (P5.13).
 */
function readInFull(h: (ReturnType<typeof btcoSignerHistory> & { complete: boolean }) | undefined, at: Position): boolean {
  return !!h && h.complete && (!h.endsBefore || chainOrder(h.endsBefore, at) > 0);
}

/** The P9.15 table for one inscribed entry. */
function judgeEntry(
  entry: OgEntry, ref: { did: string; versionId: string; verificationMethod: string }, preAnchor: boolean,
  at: Position, signers: SignerState["logs"], c: JudgeContext, authorDid: string,
): EntryResult {
  const method = signerMethodOf(ref.did)!;
  if (versionNumber(ref.versionId) > OG_LIMITS.signerVersions) return { status: "rejected", rule: "P14.13" }; // row 2
  let version: SignerVersion | undefined;
  let stateAt: SignerVersion | undefined;
  if (method === "did:btco") {
    const h = c.btco.get(ref.did);
    if (!readInFull(h, at)) return preAnchor ? { status: "incomplete", did: ref.did } : { status: "unverifiable", did: ref.did, versionId: ref.versionId }; // row 4
    if (!h) return { status: "incomplete", did: ref.did };
    const before = h.versions.filter((_, k) => chainOrder(h.positions[k], at) < 0);
    version = before.find((v) => v.versionId === ref.versionId);
    if (!version) return { status: "rejected", rule: "P5.13" }; // row 5
    stateAt = before[before.length - 1];
  } else {
    const h = signers.get(ref.did)?.history;
    if (!h) return { status: "rejected", rule: "P9.33" }; // row 3
    const found = lookupVersion(h, ref.versionId, method);
    if (!("found" in found)) return { status: "rejected", rule: "P9.15" }; // row 3
    version = found.found;
    stateAt = h.versions[h.versions.length - 1];
  }
  try {
    checkBinding(entry, ref, version); // row 1: proof under P5.3 at the named version
  } catch (error) {
    if (error instanceof OgRuleError) return { status: "rejected", rule: error.rule, identity: true };
    throw error;
  }
  // Row 6 (ccf4a69): a post-anchor editor entry also needs the author DID's state at the
  // inscription (P5.18); a did:btco author whose sat is not read in full leaves it undecided.
  // Missing author evidence is never accepting.
  if (!preAnchor && isEditorEntry(entry) && signerMethodOf(authorDid) === "did:btco") {
    const a = c.btco.get(authorDid);
    const authorRef = stateOf(entry).author;
    if (!readInFull(a, at)) return { status: "unverifiable", did: authorDid, versionId: authorRef.versionId };
  }
  if (preAnchor) return { status: "accepted" }; // row 7
  // Row 8: the key in the signer's state at the inscription, not deactivated; an editor also needs the author's.
  const key = (entry.proof[0] as JsonObject).verificationMethod as string;
  const vm = Array.isArray(version.document.verificationMethod) ? (version.document.verificationMethod as JsonObject[]).find((v) => v.id === key) : undefined;
  const pk = vm?.publicKeyMultibase as string | undefined;
  if (!stateAt || stateAt.deactivated || !pk || !listsKey(stateAt.document, pk)) return { status: "rejected", rule: "P9.15", identity: true };
  if (isEditorEntry(entry)) {
    const am = signerMethodOf(authorDid) === "did:btco" ? c.btco.get(authorDid) : signers.get(authorDid)?.history;
    const latest = am?.versions.filter((_, k) => !("positions" in am) || chainOrder((am as ReturnType<typeof btcoSignerHistory>).positions[k], at) < 0).pop();
    if (latest?.deactivated) return { status: "rejected", rule: "P5.18" };
  }
  return { status: "accepted" }; // row 9
}

/** Judge an anchoring publication (head undefined) or a later one (P9.15, P9.17, P9.32, P9.33). */
async function judge(pub: Publication, head: Head | undefined, signersIn: SignerState["logs"], c: JudgeContext): Promise<Judged & { head?: Head }> {
  const out: Judged & { head?: Head } = { ok: false, entries: [], results: [], signers: clone(signersIn) };
  const fail = (rule: string, identity = false) => Object.assign(out, { ok: false, rule, identity });
  if (pub.invalid) return fail(pub.invalid.rule);
  const raw = pub.readings.flatMap((p) => p.reading.metadata.entries);
  const histories = pub.readings.flatMap((p) => (p.reading.metadata.signers ?? []).map((s) => ({ s, source: `inscribed:${p.read.id}` })));
  if (pub.readings[pub.readings.length - 1].reading.metadata.entries.length === 0) return fail("P9.32"); // the last entry is in the final part
  try {
    out.entries = raw.map((e) => checkEntryShape(e));
  } catch (error) {
    return fail(error instanceof OgRuleError ? error.rule : "P14.27");
  }
  if (!head) {
    out.original = typeof out.entries[0].state?.id === "string" ? out.entries[0].state.id : undefined;
  } else if (out.entries.length !== 1) return fail("P9.17");
  // Signer histories first: a publication's own history counts for its entries (P9.33).
  try {
    for (const { s, source } of histories) await addSignerHistories([s], out.signers, source);
  } catch (error) {
    return fail(error instanceof OgRuleError ? error.rule : "P9.33");
  }
  let ctx = head?.ctx;
  let lastVersions = new Map(head?.lastVersions ?? []);
  const genesis = head ? undefined : out.entries[0];
  for (let k = 0; k < out.entries.length; k++) {
    const e = out.entries[k];
    const index = head ? head.index + 1 : k;
    const prev = head ? head.entry : out.entries[k - 1];
    try {
      if (index === 0 && e.parameters.method !== OG_METHOD) reject("P14.1", "METHOD_UNSUPPORTED", "not this method", "unsupported-profile");
      checkChainLink(e, index, prev, (head ? head.ctx.genesis : genesis!).parameters.scid as string);
      checkParameters(e, index, isEditorEntry(e));
      const context = ctx ?? genesisContext(e);
      checkTransition(context, e, index);
      // P9.10: the anchoring entry is the last of the anchoring publication, naming this sat.
      const btco = stateOf(e).asset.aliases.find((a) => a.startsWith("did:btco:"));
      if (!head && k < out.entries.length - 1 && btco) reject("P9.17", "ANCHOR_NOT_LAST", "the anchoring entry is the last entry of the anchoring publication");
      if (!head && k === out.entries.length - 1 && btco !== c.sat) reject("P9.10", "ANCHOR_SAT", "the last entry is not an anchoring entry naming this sat");
      ctx = advance(context, e);
    } catch (error) {
      if (error instanceof OgRuleError) {
        out.results.push({ status: "rejected", rule: error.rule });
        return fail(error.rule);
      }
      throw error;
    }
    const s = stateOf(e);
    const ref = s.editor ?? s.author;
    const last = lastVersions.get(ref.did);
    if (last !== undefined && versionNumber(ref.versionId) < last) {
      out.results.push({ status: "rejected", rule: "P5.8" });
      return fail("P5.8");
    }
    const preAnchor = !head && k < out.entries.length - 1;
    const r = judgeEntry(e, ref, preAnchor, pub.final, out.signers, c, s.author.did);
    out.results.push(r);
    if (r.status === "rejected") return fail(r.rule, !!r.identity);
    if (r.status === "unverifiable") out.unverifiable = { did: r.did, versionId: r.versionId };
    if (r.status === "incomplete") (out.incomplete ??= []).push(r.did);
    if (r.status === "accepted" || r.status === "incomplete") lastVersions = new Map(lastVersions).set(ref.did, versionNumber(ref.versionId));
  }
  try {
    out.fullBody = checkPublicationShape(pub, out.entries[out.entries.length - 1]);
  } catch (error) {
    return fail(error instanceof OgRuleError ? error.rule : "P9.17");
  }
  out.ok = true;
  const lastEntry = out.entries[out.entries.length - 1];
  out.head = { entry: lastEntry, ctx: ctx!, index: (head?.index ?? -1) + out.entries.length, lastVersions, position: pub.final };
  return out;
}

// ---------------------------------------------------------------------------
// The anchored report

interface SatOutcome {
  sat: MergedSat;
  /** The anchoring publication for our Original on this sat, if one is valid. */
  anchor?: { pub: Publication; judged: Judged & { head?: Head } };
  /** An earlier anchoring publication for our Original that cannot be decided yet (P9.16). */
  undetermined?: Publication;
  takenByOther?: boolean;
}

async function anchorOnSat(sat: MergedSat, original: string, c: JudgeContext): Promise<{ outcome: SatOutcome; publications: Publication[] }> {
  const { publications } = publicationsOf(sat);
  const outcome: SatOutcome = { sat };
  for (const pub of publications) {
    const judged = await judge(pub, undefined, new Map(), { ...c, sat: sat.sat });
    if (!judged.ok) continue;
    if (judged.original !== original) {
      outcome.takenByOther = true; // P9.34: the sat is taken; later inscriptions for another did:og are rejected
      break;
    }
    if (judged.incomplete?.length) {
      outcome.undetermined = pub; // P9.16: cannot decide it while a did:btco signer's sat is not read in full
      break;
    }
    outcome.anchor = { pub, judged };
    break;
  }
  return { outcome, publications };
}

async function verifyAnchored(evidence: EvidenceSet, gathered: Gathered): Promise<Report> {
  // The prior format (T14-085): reveal transactions whose envelopes carry no og metaprotocol.
  const txs = evidence.inputs.filter((i) => i.kind === "transaction");
  if (txs.length) {
    for (const t of txs) {
      const tx = parseTransaction(t.bytes);
      for (const env of tx.inputs.flatMap((i) => envelopesInWitness(i.witness))) {
        const r = readInscription(env);
        if (r.kind === "other") {
          const body = parseEnvelope(env)?.body;
          const log = body ? parseLogFile(body) : undefined;
          const g = log?.values[0];
          const method = isJsonObject(g) && isJsonObject(g.parameters) ? g.parameters.method : undefined;
          if (typeof method === "string" && method !== OG_METHOD) {
            // The log's method value is not this draft's, and its inscriptions carry no og metaprotocol (P14.1, P9.31).
            return unsupportedReport(evidence);
          }
        }
      }
    }
  }
  const network = evidence.network ?? null;
  const depth = evidence.depth ?? 1;
  const groups = new Map<string, SatRead[]>();
  for (const r of [...(evidence.sats ?? []), ...satReadsFromInputs(evidence)]) groups.set(r.sat, [...(groups.get(r.sat) ?? []), r]);
  const merged = new Map<string, MergedSat>();
  for (const [sat, reads] of groups) {
    const m = mergeSat(sat, reads, depth);
    if (m.network === network) merged.set(sat, m); // P9.31, P9.34: only the genesis network's reads are evidence
  }
  const c: JudgeContext = { original: evidence.original, sat: "", network: network ?? "mainnet", btco: new Map() };
  for (const m of merged.values()) {
    // Any sat read can be a did:btco signer's (P5.13); it is used only for DIDs entries name.
    const btcoDid = m.sat;
    c.btco.set(btcoDid, { ...btcoSignerHistory(btcoDid, m), complete: m.complete && !m.disputed });
  }

  // The anchor (P9.16): the first valid anchoring publication in chain order, over every sat read.
  const outcomes: Array<{ outcome: SatOutcome; publications: Publication[] }> = [];
  for (const m of merged.values()) {
    // An anchoring sat must be read in full, every inscription on it read (P9.17); a sat that is not is missing evidence.
    if (m.disputed || !m.complete || m.inscriptions.some((i) => i.unread)) continue;
    outcomes.push(await anchorOnSat(m, evidence.original, c));
  }
  const disputedAnchoring = [...merged.values()].some((m) => m.disputed || !m.complete || m.inscriptions.some((i) => i.unread));
  const candidates = outcomes.filter((o) => o.outcome.anchor || o.outcome.undetermined)
    .sort((a, b) => chainOrder((a.outcome.anchor?.pub ?? a.outcome.undetermined)!.final, (b.outcome.anchor?.pub ?? b.outcome.undetermined)!.final));
  const first = candidates[0];

  const prior = gathered.prior ?? null;
  if (!first || first.outcome.undetermined) {
    // Not anchored on any sat read, or missing evidence: what the copies show, with the Bitcoin result.
    // An undetermined anchoring publication's entries are a copy of the log too (P7.14), read without the anchor.
    const pending = first?.outcome.undetermined;
    const withPending = pending ? { ...gathered, copies: [...gathered.copies, { source: `inscribed:${pending.final.id}`, values: pending.readings.flatMap((p) => p.reading.metadata.entries) }] } : gathered;
    // Sats read in full at the tip with no anchoring publication of this Original (P9.5).
    const readSats = new Set([...merged.values()].filter((m) => !m.disputed && m.complete && !m.inscriptions.some((i) => i.unread)).map((m) => m.sat));
    // The prior anchor's sat, read in full without it: a reorganization removed it (P9.5, P9.36).
    const lost = !!prior?.bitcoin && readSats.has(prior.bitcoin.sat);
    const report = await verifyOffChain(evidence, withPending, { bitcoinRead: true, readSats, causes: lost ? { head: "reorganization", holder: "reorganization" } : { head: "evidence", holder: "evidence" } });
    const a = report.axes as Axes;
    const extra: Diagnostic[] = [];
    // A sat whose indexes disagree, or that is not read in full, and that carries Originals inscriptions or an anchor the copies name.
    const named = new Set(report.diagnostics.filter((d) => d.code === "anchoring-sat-not-read").map((d) => d.item.id));
    for (const m of merged.values()) {
      if (readSats.has(m.sat) || named.has(m.sat)) continue;
      const carries = m.inscriptions.some((i) => !i.unread && readInscription(i.envelope).kind !== "other") || m.inscriptions.some((i) => i.unread);
      if (carries) extra.push({ code: "anchoring-sat-not-read", rule: m.disputed ? "P9.10" : "P9.17", item: { kind: "sat", id: m.sat }, reason: m.disputed ? "The indexes used disagree on this sat's inscriptions." : "This sat is not read in full." });
    }
    report.diagnostics = sortDiagnostics([...report.diagnostics, ...extra]);
    if (pending) a.bitcoin = "undetermined";
    else if (report.diagnostics.some((d) => d.code === "anchoring-sat-not-read") || disputedAnchoring && !readSats.size) a.bitcoin = "missing-evidence";
    else a.bitcoin = "not-anchored";
    a.offline = offlineFrom(report.diagnostics);
    a.outcome = outcomeOf(a);
    // With the anchoring sat not read in full, no holder is claimed either way (T9-136).
    if (a.bitcoin === "missing-evidence") report.changes = report.changes.filter((ch) => ch.kind !== "holder");
    return report;
  }

  // Follow the anchoring sat's publications that extend the head (P9.13, P9.36).
  const anchorSat = first.outcome.sat;
  const anchor = first.outcome.anchor!;
  const labels: EntryLabel[] = [];
  const unverifiable: NonNullable<Report["bitcoin"]>["unverifiable"] = [];
  const waiting: NonNullable<Report["bitcoin"]>["waiting"] = [];
  const bodies = new Map<string, Uint8Array>();
  let signers = anchor.judged.signers;
  let head = anchor.judged.head!;
  const inscribed: Array<{ entry: OgEntry; block: number; ordering: "existed-by-block" | "chain-ordered" }> = [];
  anchor.judged.entries.forEach((e, k) => inscribed.push({ entry: e, block: anchor.pub.final.height, ordering: k < anchor.judged.entries.length - 1 ? "existed-by-block" : "chain-ordered" }));
  if (anchor.judged.fullBody) bodies.set(resourceDigest(anchor.judged.fullBody), anchor.judged.fullBody);
  let blockedOn: { inscription: string; head: string } | undefined;
  const acceptedInscriptions: string[] = anchor.pub.parts.map((p) => p.id);
  const afterAnchor = first.publications.filter((p) => chainOrder(p.final, anchor.pub.final) > 0);
  for (const pub of afterAnchor) {
    if (blockedOn) {
      // P9.36: a later publication from the same head, or extending the unverifiable one, waits on it.
      waiting.push({ inscription: pub.parts[0].id, waitsOn: blockedOn.inscription });
      continue;
    }
    const judged = await judge(pub, head, signers, { ...c, sat: anchorSat.sat });
    const entryId = judged.entries[0]?.versionId;
    if (!judged.ok) {
      // Not extending the head (another branch, or another Original): ignored; otherwise rejected.
      const extends_ = judged.entries.length === 1 && extendsHead(judged.entries[0], head);
      if (entryId) labels.push(extends_ ? { versionId: entryId, status: "rejected", rule: judged.rule ?? "P9.15" } : { versionId: entryId, status: "ignored" });
      continue;
    }
    if (judged.unverifiable) {
      unverifiable.push({ inscription: pub.final.id, did: judged.unverifiable.did, versionId: judged.unverifiable.versionId });
      labels.push({ versionId: entryId, status: "unverifiable" });
      blockedOn = { inscription: pub.final.id, head: head.entry.versionId };
      continue;
    }
    signers = judged.signers;
    head = judged.head!;
    acceptedInscriptions.push(...pub.parts.map((p) => p.id));
    inscribed.push({ entry: judged.entries[0], block: pub.final.height, ordering: "chain-ordered" });
    if (judged.fullBody) bodies.set(resourceDigest(judged.fullBody), judged.fullBody);
  }
  // Copies' entries that are not on the sat: after the anchor they are ignored (P9.12, T9-005); before
  // it they are on a branch that lost to the anchor, so conflicting (P7.19, P9.16).
  const onSat = new Set(inscribed.map((x) => x.entry.versionId));
  const anchorNumber = versionNumber(anchor.judged.entries[anchor.judged.entries.length - 1].versionId);
  for (const copy of gathered.copies) for (const v of copy.values) {
    if (!isJsonObject(v) || typeof v.versionId !== "string" || onSat.has(v.versionId) || labels.some((l) => l.versionId === v.versionId)) continue;
    labels.push({ versionId: v.versionId, status: versionNumber(v.versionId) < anchorNumber ? "conflicting" : "ignored" });
  }

  // Labels of the accepted entries (P7.19): inscribed entries are current-key if accepted.
  inscribed.forEach(({ entry, block, ordering }, k) => {
    labels.push({
      versionId: entry.versionId, status: "accepted", authority: "current-key",
      endorsed: inscribed.slice(k + 1).some((x) => !isEditorEntry(x.entry)), ordering, block,
    });
  });
  labels.sort((a, b) => versionNumber(a.versionId) - versionNumber(b.versionId) || (a.versionId < b.versionId ? -1 : 1));

  // Diagnostics (P14.25) and availability: inscribed full bodies, supplied and packaged resources (P7.4, P9.18).
  const diagnostics: Diagnostic[] = [];
  let unavailable = 0;
  let versions = 0;
  for (const { entry } of inscribed) {
    for (const t of stateOf(entry).transitions) {
      versions++;
      const bytes = bodies.get(t.to) ?? gathered.resources.get(t.to);
      if (bytes) continue;
      unavailable++;
      const mismatched = gathered.mismatched.some((m) => m.digest === t.to);
      diagnostics.push({ code: mismatched ? "resource-mismatch" : "resource-missing", rule: "P7.4", item: { kind: "resource", id: t.to, versionId: entry.versionId }, reason: mismatched ? "The bytes supplied for this resource version do not match its descriptor." : "The evidence set does not hold the bytes of this resource version." });
    }
  }
  const availability: Axes["availability"] = unavailable === 0 ? "complete" : unavailable === versions ? "none" : "partial";
  for (const l of labels) if (l.status === "rejected") diagnostics.push({ code: "entry-rejected", rule: l.rule, item: { kind: "entry", id: l.versionId }, reason: `The entry fails ${l.rule}.` });
  for (const u of unverifiable) {
    diagnostics.push({ code: "inscription-unverifiable", rule: "P9.15", item: { kind: "inscription", id: u.inscription }, reason: `It names ${u.did}, whose sat is not read in full.` });
    if (signerMethodOf(u.did) === "did:btco") diagnostics.push({ code: "signer-sat-not-read", rule: "P9.35", item: { kind: "sat", id: u.did }, reason: "The did:btco signer's sat is not read in full for this inscription." });
  }
  for (const w of waiting) diagnostics.push({ code: "publication-waiting", rule: "P9.36", item: { kind: "inscription", id: w.inscription }, reason: `It waits on ${w.waitsOn}.` });
  for (const i of gathered.invalidInputs) diagnostics.push({ code: "input-unusable", rule: "P7.17", item: { kind: "input", id: i.source }, reason: i.error.message });
  const sortedDiagnostics = sortDiagnostics(diagnostics);

  // Signers relied on (P7.8): inscribed histories, freshness established by chain order.
  const signerLabels: SignerLabel[] = [];
  const seen = new Set<string>();
  for (const { entry } of inscribed) {
    const s = stateOf(entry);
    const ref = s.editor ?? s.author;
    if (seen.has(ref.did)) continue;
    seen.add(ref.did);
    const role = s.editor ? "editor" : "author";
    const h = signers.get(ref.did);
    if (h) signerLabels.push({ did: ref.did, role, latestVersionId: h.entries[h.entries.length - 1].versionId as string, source: h.source, freshness: "established" });
    else {
      const b = c.btco.get(ref.did);
      const latest = b?.versions[b.versions.length - 1];
      if (latest) signerLabels.push({ did: ref.did, role, latestVersionId: latest.versionId, source: `index:${latest.inscription}`, freshness: "established" });
    }
  }


  const conflictingAnchors = candidates.slice(1).filter((x) => x.outcome.anchor).map((x) => ({ sat: x.outcome.sat.sat, inscription: x.outcome.anchor!.pub.final.id }));
  const uniqueness = evidence.originalsIndex ? { "established-through": evidence.originalsIndex.through } : "provisional" as const;
  const rest: Omit<Axes, "outcome"> = {
    binding: "bound", history: "valid", identity: "complete", authority: "current", state: "current",
    availability, offline: offlineFrom(sortedDiagnostics), bitcoin: "anchored",
  };
  const report: Report = {
    type: "OriginalsVerificationReport",
    profile: OG_METHOD,
    original: evidence.original,
    checkpoint: head.entry.versionId,
    evidence: { inputs: reportInputs(evidence), network, tip: evidence.tip ?? null, depth: evidence.depth ?? null },
    axes: { outcome: outcomeOf(rest), ...rest },
    entries: labels,
    signers: signerLabels,
    diagnostics: sortedDiagnostics,
    changes: [],
    bitcoin: {
      sat: anchorSat.sat,
      holder: { address: anchorSat.holder, uniqueness },
      conflictingAnchors, unverifiable, waiting,
    },
  };
  report.changes = changeRecords(prior, { checkpoint: report.checkpoint, holder: { sat: anchorSat.sat, address: anchorSat.holder } }, anchoredCauses(prior, anchorSat.sat, report, acceptedInscriptions, conflictingAnchors));
  return report;
}

/** The cause of each change against the prior result (P14.25, P9.36, P9.16, P9.5). */
function anchoredCauses(prior: Report | null, sat: string, now: Report, accepted: string[], conflicting: Array<{ sat: string }>): { head: ChangeRecord["cause"]; holder: ChangeRecord["cause"] } {
  if (!prior?.bitcoin) return { head: "evidence", holder: "evidence" };
  if (prior.bitcoin.sat !== sat) {
    // An earlier anchor on another sat now wins (P9.16).
    const c = conflicting.some((x) => x.sat === prior.bitcoin!.sat) ? "earlier-anchor" : "evidence";
    return { head: c, holder: c };
  }
  const priorHeadNow = now.entries.find((e) => e.versionId === prior.checkpoint);
  let head: ChangeRecord["cause"];
  if (prior.bitcoin.unverifiable.some((u) => accepted.includes(u.inscription))) head = "resolved";
  else if (priorHeadNow?.status === "accepted") head = "publication";
  else if (prior.checkpoint && !priorHeadNow) head = "reorganization";
  else head = "evidence";
  return { head, holder: head === "reorganization" ? "reorganization" : "evidence" };
}

/** `sat-read` inputs (P9.31): JSON `{network, sat, tip, inscriptions, holder?, complete?}`; envelopes come from the inscription inputs. */
function satReadsFromInputs(evidence: EvidenceSet): SatRead[] {
  const envelopes = new Map(evidence.inputs.filter((i) => i.kind === "inscription").map((i) => [i.source.replace(/^index:/, ""), i.bytes]));
  const out: SatRead[] = [];
  for (const i of evidence.inputs) {
    if (i.kind !== "sat-read") continue;
    let r: { network: BitcoinNetwork; sat: number | string; inscriptions: Array<{ id: string; sat?: number | string; block?: number; height?: number; txIndex: number; inscriptionIndex: number; confirmations: number }>; holder?: string | null; complete?: boolean };
    try {
      r = JSON.parse(new TextDecoder().decode(i.bytes)) as typeof r;
    } catch {
      continue;
    }
    out.push({
      sat: btcoDid(r.network, r.sat), index: `sat-read:${i.source}`, complete: r.complete !== false, holder: r.holder ?? null,
      inscriptions: r.inscriptions.map((x) => {
        const envelope = envelopes.get(x.id);
        return { id: x.id, sat: String(x.sat ?? r.sat), height: x.height ?? x.block ?? 0, txIndex: x.txIndex, inscriptionIndex: x.inscriptionIndex, confirmations: x.confirmations, envelope: envelope ?? new Uint8Array(), unread: !envelope };
      }),
    });
  }
  return out;
}

function extendsHead(entry: OgEntry, head: Head): boolean {
  try {
    checkChainLink(entry, head.index + 1, head.entry, head.ctx.genesis.parameters.scid as string);
    return true;
  } catch {
    return false;
  }
}

registerAnchoredEvaluator(verifyAnchored);
