/**
 * did:og on Bitcoin (P9.10–P9.36): publications on the anchoring sat, read
 * as ord 0.29.x reads them (P9.31), in chain order (block height, transaction
 * index, inscription index; P9.13), at one tip. The anchoring publication
 * carries the log from genesis through the anchoring entry (P9.17); each later
 * publication one entry. No inscription carries a signer DID history (D22,
 * 22 November 2026): a did:vh or did:webvh signer's log is a supplied signer
 * history in the evidence set (P7.8, P7.17), and each entry is checked at the
 * version it names (P5.3); a did:btco signer's versions come from its own sat
 * (P5.13). Each entry is decided by the first matching row of the P9.15 table.
 * A sat holds at most one Original (P9.34); the first valid anchor in chain
 * order wins (P9.16).
 */
import { isJsonObject, type JsonObject } from "../json/index.js";
import { decodeCbor } from "../originals/cbor.js";
import { checkChainLink, checkEntryShape, checkParameters, parseLogFile, resourceDigest, versionNumber, type OgEntry } from "./log.js";
import { envelopesInWitness, parseEnvelope, parseTransaction, readInscription, type InscriptionReading } from "./inscription.js";
import { offlineFrom, outcomeOf, reportInputs, sortDiagnostics, type Axes, type Diagnostic, type EntryLabel, type EvidenceSet, type InscriptionRead, type Report, type SatRead, type SignerLabel } from "./report.js";
import { OG_LIMITS, OG_METHOD, OgRuleError, reject } from "./rules.js";
import { checkBinding, listsKey, lookupVersion, type SignerHistory, type SignerVersion } from "./signers.js";
import { advance, btcoDid, checkTransition, genesisContext, isEditorEntry, parseBtco, signerMethodOf, stateOf, type BitcoinNetwork, type BranchContext } from "./state.js";
import { byLogOrder, registerAnchoredEvaluator, signerLabelOf, signerLogs, unsupportedReport, verifyHistories, verifyOffChain, type Gathered, type Histories } from "./verify.js";

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
  /** Set when this inscription is itself rejected (P9.31, P14.12); `reading` then holds what could be read of it. */
  invalid?: { rule: string; reason: string };
}

export interface Publication {
  parts: InscriptionRead[];
  /** Readings of its parts, as far as each could be read. */
  readings: Part[];
  /** Set when the publication is rejected as a whole before its entries are judged. */
  invalid?: { rule: string; reason: string };
  final: InscriptionRead;
}

/**
 * Group a sat's Originals inscriptions into publications in chain order (P9.32). An Originals inscription
 * that is rejected under P9.31 or P14.12 is rejected with the publication it belongs to: when its `part`
 * can still be read it takes its place in that publication, which is then rejected as a whole; otherwise
 * it stands alone.
 */
export function publicationsOf(sat: MergedSat): { publications: Publication[]; ignored: InscriptionRead[] } {
  const publications: Publication[] = [];
  const ignored: InscriptionRead[] = [];
  let open: Part[] = [];
  const close = (invalid?: Publication["invalid"]) => {
    if (open.length) publications.push({ parts: open.map((p) => p.read), readings: open, final: open[open.length - 1].read, invalid: open.find((p) => p.invalid)?.invalid ?? invalid });
    open = [];
  };
  for (const read of sat.inscriptions) {
    const r = readInscription(read.envelope, { network: sat.network, height: read.height });
    if (r.kind === "other") {
      ignored.push(read); // not an Originals inscription; does not interrupt a publication (P9.31, P9.32)
      continue;
    }
    let item: Part;
    if (r.kind === "invalid") {
      const invalid = { rule: r.rule, reason: r.reason };
      if (!r.partial) {
        if (open.length) close({ rule: "P9.32", reason: "interrupted by another Originals inscription" });
        publications.push({ parts: [read], readings: [], final: read, invalid });
        continue;
      }
      const metadata = { entries: r.partial.entries, ...(r.partial.part ? { part: r.partial.part } : {}) };
      item = { read, reading: { kind: "originals", metadata, metadataBytes: 0, contentType: r.partial.contentType, body: r.partial.body }, invalid };
    } else {
      item = { read, reading: r };
    }
    const part = item.reading.metadata.part;
    if (open.length) {
      const [, n] = open[0].reading.metadata.part!;
      if (part && part[1] === n && part[0] === open.length + 1) {
        open.push(item);
        if (part[0] === n) close();
        continue;
      }
      close({ rule: "P9.32", reason: "interrupted by another Originals inscription" });
    }
    if (!part) publications.push({ parts: [read], readings: [item], final: read, invalid: item.invalid });
    else if (part[0] === 1) open = [item];
    else publications.push({ parts: [read], readings: [item], final: read, invalid: item.invalid ?? { rule: "P9.32", reason: "a part that does not follow part 1" } });
  }
  // A publication whose final part has not appeared changes nothing (P9.32).
  return { publications, ignored };
}

// ---------------------------------------------------------------------------
// Judging publications

interface Head {
  entry: OgEntry;
  ctx: BranchContext;
  index: number;
  lastVersions: Map<string, number>;
  position: Position;
}

/**
 * What is missing when an entry cannot be decided: a did:btco signer's sat not read in full (P9.35),
 * or a did:vh / did:webvh signer's history not supplied (`history`) or not reaching the version the
 * entry names (`version`) (D22; P5.6, P7.8).
 */
type Missing = "sat" | "history" | "version";

type EntryResult =
  | { status: "accepted" }
  | { status: "rejected"; rule: string; identity?: boolean }
  | { status: "unverifiable"; did: string; versionId: string; missing: Missing }
  | { status: "incomplete"; did: string; versionId: string; missing: Missing };

export interface MissingSigner {
  did: string;
  versionId: string;
  missing: Missing;
}

interface Judged {
  ok: boolean;
  rule?: string;
  identity?: boolean;
  entries: OgEntry[];
  results: EntryResult[];
  unverifiable?: MissingSigner;
  incomplete?: MissingSigner[];
  fullBody?: Uint8Array;
  original?: string;
}

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

interface JudgeContext {
  original: string;
  sat: string;
  network: BitcoinNetwork;
  btco: Map<string, ReturnType<typeof btcoSignerHistory> & { complete: boolean }>;
  /** The did:vh and did:webvh signer histories the evidence set supplies, verified from genesis (P7.8, P7.17; D22). */
  histories: Histories;
}

/**
 * P9.35: a did:btco signer's sat is read in full for an inscription when the
 * evidence set holds its complete list at the tip and every inscription on it
 * before the candidate was read (P5.13).
 */
function readInFull(h: (ReturnType<typeof btcoSignerHistory> & { complete: boolean }) | undefined, at: Position): boolean {
  return !!h && h.complete && (!h.endsBefore || chainOrder(h.endsBefore, at) > 0);
}

/**
 * The P9.15 table for one inscribed entry. `anchoring` is true for every entry of the anchoring
 * publication, where missing evidence leaves the anchor undetermined (P9.16); after it, missing
 * evidence makes the inscription unverifiable (P9.36). Missing evidence never accepts.
 */
function judgeEntry(
  entry: OgEntry, ref: { did: string; versionId: string; verificationMethod: string }, anchoring: boolean, preAnchor: boolean,
  at: Position, c: JudgeContext, authorDid: string,
): EntryResult {
  const method = signerMethodOf(ref.did)!;
  const missing = (did: string, versionId: string, what: Missing): EntryResult => (anchoring ? { status: "incomplete", did, versionId, missing: what } : { status: "unverifiable", did, versionId, missing: what });
  if (versionNumber(ref.versionId) > OG_LIMITS.signerVersions) return { status: "rejected", rule: "P14.13" }; // row 2
  let version: SignerVersion | undefined;
  let stateAt: SignerVersion | undefined;
  if (method === "did:btco") {
    const h = c.btco.get(ref.did);
    if (!readInFull(h, at) || !h) return missing(ref.did, ref.versionId, "sat"); // row 4
    const before = h.versions.filter((_, k) => chainOrder(h.positions[k], at) < 0);
    version = before.find((v) => v.versionId === ref.versionId);
    if (!version) return { status: "rejected", rule: "P5.13" }; // row 5
    stateAt = before[before.length - 1];
  } else {
    // D22: the signer's log comes from resolution, supplied in the evidence set; the entry is checked at
    // the version it names (P5.3), in any supplied log that verifies in full (owner decision B). No such
    // log, or none holding that versionId, whether short or a fork, is missing evidence, never a rejection.
    const found = lookupVersion(signerLogs(c.histories, ref.did), ref.versionId);
    if ("missing" in found) return missing(ref.did, ref.versionId, found.missing); // row 3
    if ("mismatch" in found) return { status: "rejected", rule: "P5.3", identity: true };
    version = found.found;
  }
  try {
    checkBinding(entry, ref, version); // row 1: proof under P5.3 at the named version
  } catch (error) {
    if (error instanceof OgRuleError) return { status: "rejected", rule: error.rule, identity: true };
    throw error;
  }
  // Row 6 (ccf4a69): a post-anchor editor entry also needs a did:btco author DID's state at the
  // inscription (P5.18); an author whose sat is not read in full leaves it undecided.
  if (!preAnchor && isEditorEntry(entry) && signerMethodOf(authorDid) === "did:btco") {
    const a = c.btco.get(authorDid);
    const authorRef = stateOf(entry).author;
    if (!readInFull(a, at)) return missing(authorDid, authorRef.versionId, "sat");
  }
  if (preAnchor) return { status: "accepted" }; // row 7
  // Row 8, did:btco signers only (D22): the key in the signer's state at the inscription, not deactivated.
  // A did:vh / did:webvh signer's later removal or deactivation never invalidates an inscribed entry.
  if (method === "did:btco") {
    const key = (entry.proof[0] as JsonObject).verificationMethod as string;
    const vm = Array.isArray(version.document.verificationMethod) ? (version.document.verificationMethod as JsonObject[]).find((v) => v.id === key) : undefined;
    const pk = vm?.publicKeyMultibase as string | undefined;
    if (!stateAt || stateAt.deactivated || !pk || !listsKey(stateAt.document, pk)) return { status: "rejected", rule: "P9.15", identity: true };
  }
  // P5.18, did:btco authors only (D22): an editor entry inscribed after the author DID's deactivation.
  if (isEditorEntry(entry) && signerMethodOf(authorDid) === "did:btco") {
    const am = c.btco.get(authorDid);
    const latest = am?.versions.filter((_, k) => chainOrder(am.positions[k], at) < 0).pop();
    if (latest?.deactivated) return { status: "rejected", rule: "P5.18" };
  }
  return { status: "accepted" }; // row 9
}

/** Judge an anchoring publication (head undefined) or a later one (P9.15, P9.17, P9.32). */
function judge(pub: Publication, head: Head | undefined, c: JudgeContext): Judged & { head?: Head } {
  const out: Judged & { head?: Head } = { ok: false, entries: [], results: [] };
  const fail = (rule: string, identity = false) => Object.assign(out, { ok: false, rule, identity });
  if (pub.invalid) return fail(pub.invalid.rule);
  const raw = pub.readings.flatMap((p) => p.reading.metadata.entries);
  if (pub.readings[pub.readings.length - 1].reading.metadata.entries.length === 0) return fail("P9.32"); // the last entry is in the final part
  try {
    out.entries = raw.map((e) => checkEntryShape(e));
  } catch (error) {
    return fail(error instanceof OgRuleError ? error.rule : "P14.27");
  }
  if (!head) {
    out.original = typeof out.entries[0].state?.id === "string" ? out.entries[0].state.id : undefined;
  } else if (out.entries.length !== 1) return fail("P9.17");
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
    const r = judgeEntry(e, ref, !head, preAnchor, pub.final, c, s.author.did);
    out.results.push(r);
    if (r.status === "rejected") return fail(r.rule, !!r.identity);
    if (r.status === "unverifiable") out.unverifiable = { did: r.did, versionId: r.versionId, missing: r.missing };
    if (r.status === "incomplete") (out.incomplete ??= []).push({ did: r.did, versionId: r.versionId, missing: r.missing });
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
  /**
   * Our first anchoring publication on this sat when it cannot be decided yet (P9.16), and what deciding
   * it lacks: its own entries' signers, or those of an earlier anchoring publication of another did:og on
   * this sat that cannot be decided either and may have taken it (P9.34).
   */
  undetermined?: Publication;
  lacking?: MissingSigner[];
  /** That earlier anchoring publication of another did:og, when it is what leaves ours undecided. */
  blockedBy?: Publication;
  takenByOther?: boolean;
  /**
   * Anchoring publications of our Original on this sat, before the point the sat is decided at, that are
   * rejected (P9.15, P9.17, P9.31, P9.32, P14.12): their entries as far as they can be read, and the rule.
   */
  rejected: Array<{ pub: Publication; rule: string; identity: boolean }>;
}

/** The entries a publication carries, as far as they can be read (for labels only, never evidence). */
const rawEntries = (pub: Publication): JsonObject[] => pub.readings.flatMap((p) => p.reading.metadata.entries);

/**
 * Whether a publication that is rejected was an anchoring publication of this Original on this sat: an
 * entry names the did:og and its last entry names this sat as its anchor (P9.10, P9.16).
 */
function rejectedAnchoringOf(pub: Publication, original: string, sat: string): boolean {
  const entries = rawEntries(pub);
  const last = entries[entries.length - 1];
  const aliases = isJsonObject(last?.state) && isJsonObject(last.state.asset) && Array.isArray(last.state.asset.aliases) ? last.state.asset.aliases : [];
  return aliases.includes(sat) && entries.some((e) => isJsonObject(e.state) && e.state.id === original);
}

/**
 * Our Original on one sat read in full (P9.16, P9.34). Another did:og's anchoring publication matters only
 * here, on its own sat: a valid one takes the sat; one that cannot be decided leaves ours on this sat after
 * it undecided, and is nothing to ours anywhere else (owner decision A, 22 November 2026).
 */
function anchorOnSat(sat: MergedSat, original: string, c: JudgeContext): { outcome: SatOutcome; publications: Publication[] } {
  const { publications } = publicationsOf(sat);
  const outcome: SatOutcome = { sat, rejected: [] };
  let blocker: { pub: Publication; lacking: MissingSigner[] } | undefined;
  for (const pub of publications) {
    const judged = judge(pub, undefined, { ...c, sat: sat.sat });
    if (!judged.ok) {
      if (rejectedAnchoringOf(pub, original, sat.sat)) outcome.rejected.push({ pub, rule: judged.rule ?? pub.invalid?.rule ?? "P9.15", identity: !!judged.identity });
      continue;
    }
    if (judged.original !== original) {
      if (judged.incomplete?.length) {
        // Another did:og's anchoring publication that cannot be decided yet: whether it takes the sat is
        // undetermined (P9.34), so ours later on this sat is too. Its entries are not a copy of our log.
        blocker ??= { pub, lacking: judged.incomplete };
        continue;
      }
      // P9.34: the sat is taken (by this one, or by an undecided one before it); ours after it are rejected.
      outcome.takenByOther = true;
      break;
    }
    if (blocker || judged.incomplete?.length) {
      // P9.16: cannot decide it while a did:btco signer's sat is not read in full, or a did:vh / did:webvh
      // signer's log is not supplied through the version an entry names (D22), here or for the other did:og.
      outcome.undetermined = pub;
      outcome.lacking = [...(blocker?.lacking ?? []), ...(judged.incomplete ?? [])];
      outcome.blockedBy = blocker?.pub;
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
  for (const r of [...(evidence.sats ?? []), ...satReadsFromInputs(evidence, gathered)]) groups.set(r.sat, [...(groups.get(r.sat) ?? []), r]);
  const merged = new Map<string, MergedSat>();
  for (const [sat, reads] of groups) {
    const m = mergeSat(sat, reads, depth);
    if (m.network === network) merged.set(sat, m); // P9.31, P9.34: only the genesis network's reads are evidence
  }
  const c: JudgeContext = { original: evidence.original, sat: "", network: network ?? "mainnet", btco: new Map(), histories: await verifyHistories(gathered.histories) };
  for (const m of merged.values()) {
    // Any sat read can be a did:btco signer's (P5.13); it is used only for DIDs entries name.
    const btcoDid = m.sat;
    c.btco.set(btcoDid, { ...btcoSignerHistory(btcoDid, m), complete: m.complete && !m.disputed });
  }

  // The anchor (P9.16): the first valid anchoring publication in chain order, over every sat read.
  const outcomes: Array<{ outcome: SatOutcome; publications: Publication[] }> = [];
  const readInFullSat = (m: MergedSat) => !m.disputed && m.complete && !m.inscriptions.some((i) => i.unread);
  for (const m of merged.values()) {
    // An anchoring sat must be read in full, every inscription on it read (P9.17); a sat that is not is missing evidence.
    if (!readInFullSat(m)) continue;
    outcomes.push(anchorOnSat(m, evidence.original, c));
  }
  const disputedAnchoring = [...merged.values()].some((m) => !readInFullSat(m));
  const at = (o: { outcome: SatOutcome }) => (o.outcome.anchor?.pub ?? o.outcome.undetermined)!.final;
  const valid = outcomes.filter((o) => o.outcome.anchor).sort((a, b) => chainOrder(at(a), at(b)));
  // Our anchoring publications that cannot be decided yet, each on its own sat (P9.16). On its own sat one
  // leaves the anchor undetermined; on any other sat it never blocks a valid anchor (owner decision A).
  const undecided = outcomes.filter((o) => o.outcome.undetermined).sort((a, b) => chainOrder(at(a), at(b)));
  const first = valid[0];

  if (!first) {
    // Not anchored on any sat read, or missing evidence: what the copies show, with the Bitcoin result.
    // An undetermined anchoring publication's entries are a copy of the log too (P7.14), read without the anchor.
    const pending = undecided[0]?.outcome.undetermined;
    const withPending = pending ? { ...gathered, copies: [...gathered.copies, { source: `inscribed:${pending.final.id}`, values: pending.readings.flatMap((p) => p.reading.metadata.entries) }] } : gathered;
    // Sats read in full at the tip with no anchoring publication of this Original (P9.5). A sat holding an
    // undetermined anchoring publication is not one of them, and is not missing evidence either: it was read in full.
    const undecidedSats = new Set(undecided.map((o) => o.outcome.sat.sat));
    const readSats = new Set([...merged.values()].filter((m) => readInFullSat(m) && !undecidedSats.has(m.sat)).map((m) => m.sat));
    const report = await verifyOffChain(evidence, withPending, { bitcoinRead: true, readSats, undecidedSats });
    const a = report.axes as Axes;
    const extra: Diagnostic[] = [];
    // A sat whose indexes disagree, or that is not read in full, and that carries Originals inscriptions or an anchor the copies name.
    const named = new Set(report.diagnostics.filter((d) => d.code === "anchoring-sat-not-read").map((d) => d.item.id));
    for (const m of merged.values()) {
      if (readInFullSat(m) || named.has(m.sat)) continue;
      const carries = m.inscriptions.some((i) => !i.unread && readInscription(i.envelope).kind !== "other") || m.inscriptions.some((i) => i.unread);
      if (carries) extra.push({ code: "anchoring-sat-not-read", rule: m.disputed ? "P9.10" : "P9.17", item: { kind: "sat", id: m.sat }, reason: m.disputed ? "The indexes used disagree on this sat's inscriptions." : "This sat is not read in full." });
    }
    // What each undetermined anchoring publication lacks (D22): its entries' signers' logs or sats.
    for (const o of undecided) for (const l of o.outcome.lacking ?? []) {
      const d = missingSignerDiagnostic(l);
      if (d) extra.push(d);
    }
    report.diagnostics = sortDiagnostics(dedupe([...report.diagnostics, ...extra]));
    if (pending) a.bitcoin = "undetermined";
    else if (report.diagnostics.some((d) => d.code === "anchoring-sat-not-read") || disputedAnchoring && !readSats.size) a.bitcoin = "missing-evidence";
    else a.bitcoin = "not-anchored";
    if (a.bitcoin === "not-anchored") labelRejectedAnchoring(report, outcomes);
    a.offline = offlineFrom(report.diagnostics);
    // P7.18 (T7-076): a missing target, or no entry at all, is incomplete unless something failed.
    const outcome = outcomeOf(a);
    a.outcome = outcome === "verified" && report.diagnostics.some((d) => d.code === "target-missing") ? "incomplete" : outcome;
    return report;
  }

  // Follow the anchoring sat's publications that extend the head (P9.13, P9.36).
  const anchorSat = first.outcome.sat;
  const anchor = first.outcome.anchor!;
  const labels: EntryLabel[] = [];
  const unverifiable: NonNullable<Report["bitcoin"]>["unverifiable"] = [];
  const waiting: NonNullable<Report["bitcoin"]>["waiting"] = [];
  const lacking: Array<{ signers: MissingSigner[]; sat?: string }> = [];
  const bodies = new Map<string, Uint8Array>();
  let head = anchor.judged.head!;
  const inscribed: Array<{ entry: OgEntry; block: number; ordering: "existed-by-block" | "chain-ordered" }> = [];
  anchor.judged.entries.forEach((e, k) => inscribed.push({ entry: e, block: anchor.pub.final.height, ordering: k < anchor.judged.entries.length - 1 ? "existed-by-block" : "chain-ordered" }));
  if (anchor.judged.fullBody) bodies.set(resourceDigest(anchor.judged.fullBody), anchor.judged.fullBody);
  let blockedOn: { inscription: string; head: string } | undefined;
  // Every publication the reported head depends on, for the transfer depth (P7.22).
  const headPublications: Publication[] = [anchor.pub];
  const afterAnchor = first.publications.filter((p) => chainOrder(p.final, anchor.pub.final) > 0);
  for (const pub of afterAnchor) {
    if (blockedOn) {
      // P9.36: a later publication from the same head, or extending the unverifiable one, waits on it.
      waiting.push({ inscription: pub.parts[0].id, waitsOn: blockedOn.inscription });
      continue;
    }
    const judged = judge(pub, head, { ...c, sat: anchorSat.sat });
    const entryId = judged.entries[0]?.versionId;
    if (!judged.ok) {
      // Not extending the head (another branch, or another Original): ignored; otherwise rejected.
      const extends_ = judged.entries.length === 1 && extendsHead(judged.entries[0], head);
      if (entryId) labels.push(extends_ ? { versionId: entryId, status: "rejected", rule: judged.rule ?? "P9.15" } : { versionId: entryId, status: "ignored" });
      continue;
    }
    if (judged.unverifiable) {
      unverifiable.push({ inscription: pub.final.id, did: judged.unverifiable.did, versionId: judged.unverifiable.versionId });
      lacking.push({ signers: [judged.unverifiable] });
      labels.push({ versionId: entryId, status: "unverifiable" });
      blockedOn = { inscription: pub.final.id, head: head.entry.versionId };
      continue;
    }
    head = judged.head!;
    headPublications.push(pub);
    inscribed.push({ entry: judged.entries[0], block: pub.final.height, ordering: "chain-ordered" });
    if (judged.fullBody) bodies.set(resourceDigest(judged.fullBody), judged.fullBody);
  }
  // Owner decision A: our anchoring publications on other sats that cannot be decided do not block this
  // anchor; each is listed as unverifiable, with what deciding it lacks (P9.16, P14.25).
  for (const o of undecided) {
    const pub = o.outcome.undetermined!;
    const l = o.outcome.lacking!;
    unverifiable.push({ inscription: pub.final.id, did: l[0].did, versionId: l[0].versionId });
    lacking.push({ signers: l, sat: o.outcome.sat.sat });
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
  unverifiable.forEach((u, k) => {
    const { signers: ms, sat } = lacking[k];
    const m = ms[0];
    const what = m.missing === "sat" ? `${u.did}, whose sat is not read in full` : `${u.did} at ${u.versionId}, and the evidence set holds no verifying log of it with that version`;
    diagnostics.push({ code: "inscription-unverifiable", rule: "P9.15", item: { kind: "inscription", id: u.inscription }, reason: sat ? `An anchoring publication of this Original on ${sat} that cannot be decided: it needs ${what}. It does not block the anchor, and uniqueness is not established through it.` : `It names ${what}.` });
    for (const x of ms) diagnostics.push(missingSignerDiagnostic(x)!);
  });
  for (const w of waiting) diagnostics.push({ code: "publication-waiting", rule: "P9.36", item: { kind: "inscription", id: w.inscription }, reason: `It waits on ${w.waitsOn}.` });
  for (const i of gathered.invalidInputs) diagnostics.push({ code: "input-unusable", rule: "P7.17", item: { kind: "input", id: i.source }, reason: i.error.message });
  // P7.22, P14.13: a publication's confirmations are the tip's height less its final part's block height, plus one.
  for (const pub of headPublications) {
    const n = evidence.tip ? evidence.tip.height - pub.final.height + 1 : pub.final.confirmations;
    if (n < OG_LIMITS.transferDepth) diagnostics.push({ code: "insufficient-depth", rule: "P7.22", item: { kind: "inscription", id: pub.parts[0].id }, reason: `The publication has ${n} confirmations at the tip, fewer than the transfer depth of ${OG_LIMITS.transferDepth}.` });
  }
  const sortedDiagnostics = sortDiagnostics(dedupe(diagnostics));

  // Signers relied on (P7.8): did:vh / did:webvh histories as supplied, with their source, when they were
  // obtained and whether their own witnesses establish freshness (D22); did:btco sats by chain order.
  const signerLabels: SignerLabel[] = [];
  const seen = new Set<string>();
  for (const { entry } of inscribed) {
    const s = stateOf(entry);
    const ref = s.editor ?? s.author;
    if (seen.has(ref.did)) continue;
    seen.add(ref.did);
    const role = s.editor ? "editor" : "author";
    if (signerMethodOf(ref.did) !== "did:btco") {
      // The newest version among the supplied logs that verify, and that log's source, obtained time and freshness.
      const label = signerLabelOf(c.histories, ref.did, role);
      if (label) signerLabels.push(label);
    } else {
      const b = c.btco.get(ref.did);
      const latest = b?.versions[b.versions.length - 1];
      if (latest) signerLabels.push({ did: ref.did, role, latestVersionId: latest.versionId, source: `index:${latest.inscription}`, freshness: "established" });
    }
  }

  const conflictingAnchors = valid.slice(1).map((x) => ({ sat: x.outcome.sat.sat, inscription: x.outcome.anchor!.pub.final.id }));
  // Owner decision A: an anchoring publication of this did:og on another sat that cannot be decided does not
  // block the anchor; it is listed as unverifiable, and uniqueness is never established through it.
  const uniqueness = evidence.originalsIndex && undecided.length === 0 ? { "established-through": evidence.originalsIndex.through } : "provisional" as const;
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
    bitcoin: {
      sat: anchorSat.sat,
      holder: { address: anchorSat.holder, uniqueness },
      conflictingAnchors, unverifiable, waiting,
    },
  };
  return report;
}

/**
 * `sat-read` inputs (P14.25, 45dc624): exactly `{network, sat, tip, complete, holder, inscriptions}`,
 * `sat` an integer, `tip` `{height, hash}`, `holder` `{address}` or null, and one
 * `{id, height, txIndex, inscriptionIndex, confirmations}` per inscription in chain order, with
 * `confirmations` the tip's height less `height`, plus one. Envelopes are `inscription` inputs
 * (`index:<id>`); an inscription listed without one is unread (P9.35, P5.13). A read that breaks the form,
 * or disagrees with the evidence set's network or tip, is unusable (P7.17).
 */
function satReadsFromInputs(evidence: EvidenceSet, gathered: Gathered): SatRead[] {
  const envelopes = new Map(evidence.inputs.filter((i) => i.kind === "inscription").map((i) => [i.source.replace(/^index:/, ""), i.bytes]));
  const out: SatRead[] = [];
  const exact = (o: unknown, keys: string[]): o is Record<string, unknown> =>
    isJsonObject(o) && Object.keys(o).length === keys.length && keys.every((k) => k in (o as object));
  for (const i of evidence.inputs) {
    if (i.kind !== "sat-read") continue;
    const unusable = (why: string) => gathered.invalidInputs.push({ source: i.source, error: new OgRuleError("P7.17", "SAT_READ_FORM", `the sat-read ${why}`) });
    let r: unknown;
    try {
      r = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(i.bytes));
    } catch {
      unusable("is not JSON");
      continue;
    }
    if (!exact(r, ["network", "sat", "tip", "complete", "holder", "inscriptions"])) { unusable("does not have exactly network, sat, tip, complete, holder and inscriptions"); continue; }
    const tip = r.tip as { height?: unknown; hash?: unknown };
    const holder = r.holder as { address?: unknown } | null;
    if (typeof r.network !== "string" || !Number.isSafeInteger(r.sat) || (r.sat as number) < 0 || !exact(tip, ["height", "hash"]) || !Number.isSafeInteger(tip.height) || typeof tip.hash !== "string" ||
      typeof r.complete !== "boolean" || !(holder === null || (exact(holder, ["address"]) && typeof holder.address === "string")) || !Array.isArray(r.inscriptions)) { unusable("has a member of the wrong type"); continue; }
    if (r.network !== evidence.network || !evidence.tip || tip.height !== evidence.tip.height || tip.hash !== evidence.tip.hash) { unusable("is not at the evidence set's network and tip"); continue; }
    const items = r.inscriptions as unknown[];
    const keys = ["id", "height", "txIndex", "inscriptionIndex", "confirmations"];
    const bad = items.find((x) => !exact(x, keys) || typeof x.id !== "string" || !keys.slice(1).every((k) => Number.isSafeInteger(x[k])) || x.confirmations !== (tip.height as number) - (x.height as number) + 1);
    if (bad !== undefined) { unusable("lists an inscription whose members or confirmations break the form"); continue; }
    const network = r.network;
    out.push({
      sat: btcoDid(network, r.sat as number), index: `sat-read:${i.source}`, complete: r.complete, holder: holder?.address as string | null ?? null,
      inscriptions: (items as Array<{ id: string; height: number; txIndex: number; inscriptionIndex: number; confirmations: number }>).map((x) => {
        const envelope = envelopes.get(x.id);
        return { id: x.id, sat: String(r.sat), height: x.height, txIndex: x.txIndex, inscriptionIndex: x.inscriptionIndex, confirmations: x.confirmations, envelope: envelope ?? new Uint8Array(), unread: !envelope };
      }),
    });
  }
  return out;
}

/** Diagnostics with the same code, rule and item once (their reasons may differ). */
function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const k = JSON.stringify([d.code, d.rule, d.item]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * P7.19, P7.18 (T14-003): with no anchor and the sats read in full, an anchoring publication of this
 * Original that is rejected (P9.15, P9.17, P9.31, P9.32, P14.12) is evidence the verifier considered: each
 * entry it carries that nothing else labels is `rejected` with the publication's rule, so the history is
 * `invalid`, or the identity `failed` for a signer-binding rule. When a valid anchor exists, a rejected
 * anchoring publication is simply not an anchor (P9.16) and is not labelled.
 */
function labelRejectedAnchoring(report: Report, outcomes: Array<{ outcome: SatOutcome }>): void {
  const labelled = new Set(report.entries.map((e) => e.versionId));
  const added: Diagnostic[] = [];
  let history = false;
  let identity = false;
  for (const { outcome } of outcomes) for (const r of outcome.rejected) {
    for (const e of rawEntries(r.pub)) {
      if (typeof e.versionId !== "string" || labelled.has(e.versionId)) continue;
      labelled.add(e.versionId);
      report.entries.push({ versionId: e.versionId, status: "rejected", rule: r.rule });
      added.push({ code: "entry-rejected", rule: r.rule, item: { kind: "entry", id: e.versionId }, reason: `The anchoring publication on ${outcome.sat.sat} that carries it fails ${r.rule}${r.pub.invalid ? `: ${r.pub.invalid.reason}` : ""}.` });
      if (r.identity) identity = true;
      else history = true;
    }
  }
  if (!added.length) return;
  report.entries.sort((a, b) => byLogOrder(a.versionId, b.versionId));
  report.diagnostics = sortDiagnostics([...report.diagnostics, ...added]);
  const a = report.axes as Axes;
  if (history) a.history = "invalid";
  if (identity) a.identity = "failed";
}

/** The diagnostic for one missing signer (P14.25): a did:btco sat, or a did:vh / did:webvh history or version. */
function missingSignerDiagnostic(m: MissingSigner): Diagnostic | undefined {
  if (m.missing === "sat") return { code: "signer-sat-not-read", rule: "P9.35", item: { kind: "sat", id: m.did }, reason: "The did:btco signer's sat is not read in full for this inscription." };
  if (m.missing === "version") return { code: "signer-version-missing", rule: "P7.8", item: { kind: "signer", id: m.did, versionId: m.versionId }, reason: "The supplied signer history does not reach the version the entry names." };
  return { code: "signer-history-missing", rule: "P5.6", item: { kind: "signer", id: m.did }, reason: "The signer DID's history is not in the evidence set." };
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
