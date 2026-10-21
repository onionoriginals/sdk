/**
 * Writing an anchored Original to Bitcoin (plan 011 PR 10; plan 012).
 *
 * Three heads are kept apart:
 * - the committed head: the last entry of the stored log, signed locally;
 * - a prepared or pending publication: a pair in the recovery store, built or
 *   broadcast but not accepted, which never advances anything (P9.4). While
 *   the anchoring inscription is out but Bitcoin does not show it, reads are
 *   labelled `pending-bitcoin-acceptance` (P9.18);
 * - the accepted head: the last entry Bitcoin shows on the anchoring sat
 *   under the 1-confirmation policy (decision D), read by `readAnchored`.
 *
 * What is inscribed (P9.17): the anchoring inscription carries the stored log
 * from genesis through the anchoring entry, exact stored lines in order, the
 * anchoring entry last; every later inscription carries exactly one entry,
 * the successor of the head Bitcoin accepts. Media type
 * `application/vnd.originals.vh+jsonl`, no metadata, at most 350,000 bytes
 * (`ORIGINALS_INSCRIPTION_MAX_BYTES`, provisional D6). Entries committed after
 * the anchoring entry before the anchor is accepted wait, and then go one per
 * later block.
 *
 * - `nextPendingEntry` compares the heads: the entries from the next one
 *   Bitcoin can accept to the committed head. That is the anchoring entry
 *   until Bitcoin shows the anchor, then the successor of the accepted head
 *   (P9.13).
 * - `prepareEntryInscription` builds the commit and reveal for the next entry
 *   (or an explicit `versionId`, refused unless it is next: HEAD_NOT_NEXT).
 *   Before building, it verifies the stored log through that entry and the
 *   identity evidence of every signer of it, author and editors, and refuses
 *   otherwise (ANCHORING_NOT_VERIFIED for the anchoring inscription, P9.18;
 *   ENTRY_NOT_VERIFIED after it). Resource availability does not gate it
 *   (P7.4). It returns `offChain`: what Bitcoin will not hold (P9.18). The
 *   first funding UTXO must hold the sat at offset 0: the anchoring sat for
 *   the anchoring inscription (P9.10), and the output now holding it for every
 *   later entry, which is how only the sat's holder can extend an anchored
 *   Original while only the author or an editor can sign it (P9.12). Nothing
 *   is re-signed or rebased: the bytes are the ones already committed (P9.6).
 * - Submitting and retrying are the sat builder's durable state machine:
 *   `submitPreparedInscriptionOnSat` persists before every broadcast, and
 *   `resumeInscriptionOnSat` rebroadcasts the same pair. A replacement is a
 *   new `prepareEntryInscription`, never a silent re-sign (P9.6).
 * - `catchUp` is one step of publishing the queue: it re-reads Bitcoin, finds
 *   any recorded pair for the next inscription, and says whether to resume
 *   it, wait for it, prepare the next one, or stop. One inscription is in
 *   flight at a time, so each accepted publication lands at a strictly
 *   greater height (P9.13). Editor entries are published like author entries.
 * - `readAnchored` reads the sat back; a broadcast or pending transaction never
 *   advances the published boundary (P9.4).
 * - `transferHandoff` and `verifyHandoff`: when the anchoring sat is
 *   transferred, the sender exports the resource bytes and off-chain signer
 *   DID histories it holds, and the recipient verifies them against the sat
 *   (P9.18). Nothing guarantees their replication.
 */
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { parseWitness } from "micro-ordinals";
import { OriginalsError } from "@originals/vh";
import {
  ORIGINALS_INSCRIPTION_MAX_BYTES,
  ORIGINALS_INSCRIPTION_TYPE,
  anchoringIndex,
  parseBtcoAlias,
  type OriginalsReport,
  type SatEvidence,
} from "@originals/vh/originals";
import type { OrdinalsProvider } from "../adapters/types.js";
import { prepareInscriptionOnSat, type InscribeOnSatParams, type PreparedInscriptionOnSat } from "../bitcoin/inscribe-on-sat.js";
import type { InscriptionRecoveryRecord, InscriptionRecoveryStore } from "../bitcoin/inscription-recovery.js";
import { readEvidence } from "./evidence.js";
import { InscriptionClock, satEvidence } from "./bitcoin.js";
import type { EvidencePackage, LoadedEvidence, OriginalView, OriginalsSDK } from "./sdk.js";

export { submitPreparedInscriptionOnSat, resumeInscriptionOnSat } from "../bitcoin/inscribe-on-sat.js";

type Category = ConstructorParameters<typeof OriginalsError>[0];

function refuse(category: Category, code: string, message: string, details?: Record<string, unknown>): never {
  throw new OriginalsError(category, code, message, details);
}

interface StoredLog {
  /** The stored log's lines, oldest first, exactly as signed. */
  lines: string[];
  ids: string[];
  /** The index of the anchoring entry. */
  anchor: number;
  sat: ReturnType<typeof parseBtcoAlias>;
}

/** The anchoring entry's index and sat in a log's lines (P9.10). */
function parseLines(did: string, text: string): StoredLog {
  const lines = text.trimEnd().split("\n");
  let entries: Array<{ versionId: string; state?: { asset?: { aliases?: string[] } } }>;
  try {
    entries = lines.map((l) => JSON.parse(l) as (typeof entries)[number]);
  } catch {
    refuse("invalid-evidence", "STORED_LOG_UNREADABLE", `the stored log of ${did} is not JSON Lines`);
  }
  const anchor = anchoringIndex(entries);
  const alias = anchor >= 0 ? entries[anchor].state?.asset?.aliases?.find((a) => a.startsWith("did:btco:")) : undefined;
  if (!alias) refuse("invalid-evidence", "NOT_ANCHORED", `${did} has no anchoring entry; anchor it first (P9.10)`);
  return { lines, ids: entries.map((e) => e.versionId), anchor, sat: parseBtcoAlias(alias) };
}

/** The Original's committed log, exactly as stored, and the anchoring sat it names (P9.10). */
async function storedLog(sdk: OriginalsSDK, did: string): Promise<StoredLog> {
  return parseLines(did, await sdk.committedLog(did));
}

const encoder = new TextEncoder();

/**
 * The body of the inscription that publishes the entry at `index` (P9.17):
 * the stored lines from genesis through the anchoring entry for the anchor,
 * otherwise that one stored line. Exact stored bytes, each line ending in LF.
 */
function bodyFor(log: StoredLog, index: number): Uint8Array {
  const lines = index === log.anchor ? log.lines.slice(0, log.anchor + 1) : [log.lines[index]];
  return encoder.encode(`${lines.join("\n")}\n`);
}

function checkSize(log: StoredLog, index: number, body: Uint8Array): void {
  if (body.length <= ORIGINALS_INSCRIPTION_MAX_BYTES) return;
  const details = { size: body.length, limit: ORIGINALS_INSCRIPTION_MAX_BYTES, versionId: log.ids[index] };
  if (index === log.anchor) {
    refuse("limit-exceeded", "ANCHORING_LOG_TOO_LARGE", `the log through the anchoring entry is ${body.length} bytes; an inscription holds at most ${ORIGINALS_INSCRIPTION_MAX_BYTES} (P9.17)`, details);
  }
  refuse("limit-exceeded", "INSCRIPTION_TOO_LARGE", `entry ${log.ids[index]} is ${body.length} bytes; an inscription holds at most ${ORIGINALS_INSCRIPTION_MAX_BYTES} (P9.17)`, details);
}

/** Whether the anchoring sat shows the anchor, has it in flight, or neither (P9.18). */
export type Publication =
  /** Bitcoin shows the anchor under the confirmation policy: the Original verifies as anchored. */
  | "anchored"
  /**
   * The anchoring inscription is broadcast (a recorded pair, not only
   * prepared) and Bitcoin does not show it yet, including while it is
   * confirmed but not yet indexed. Its acceptance depends on its position
   * (P5.13, P9.15, P9.16), so it is not anchored yet.
   */
  | "pending-bitcoin-acceptance"
  /** No anchor on Bitcoin and none known in flight. */
  | "not-anchored"
  /** Bitcoin evidence is missing or its indexes disagree (P9.10). */
  | "unverified";

/** The committed head, the head Bitcoin accepts, and the entries between them. */
export interface PendingEntries {
  did: string;
  /** The anchoring sat, as its did:btco alias. */
  sat: string;
  /** The last entry committed locally. */
  committed: string;
  /** The last entry Bitcoin shows on the sat (the anchor or an accepted inscription), or null before the anchor. */
  accepted: string | null;
  /** The block height of that inscription. */
  acceptedHeight: number | null;
  /** The entry Bitcoin can accept next, or null when Bitcoin shows the committed head. */
  next: string | null;
  /** The entries still to publish, from `next` to `committed`, oldest first. */
  queue: string[];
  remaining: number;
  /**
   * The anchor's state on Bitcoin. `pending-bitcoin-acceptance` needs the
   * recovery store (`recoveryStore`): without it a broadcast anchor reads as
   * `not-anchored`.
   */
  publication: Publication;
  /** The read the comparison came from. */
  view: OriginalView;
}

function pendingFrom(did: string, log: StoredLog, view: OriginalView, publication: Publication): PendingEntries {
  const anchoring = view.report.anchoring;
  let start = log.anchor;
  let accepted: string | null = null;
  let acceptedHeight: number | null = null;
  if (anchoring?.status === "anchored") {
    accepted = view.report.head;
    const k = accepted === null ? -1 : log.ids.indexOf(accepted);
    if (k < log.anchor) {
      refuse("stale-parent", "BITCOIN_HEAD_NOT_STORED", `Bitcoin shows ${accepted ?? "no head"} on ${log.sat.did}, which the stored log does not hold; load Bitcoin's history first (nothing is rebased, P2.1)`);
    }
    start = k + 1;
    acceptedHeight = (anchoring.accepted[anchoring.accepted.length - 1] ?? anchoring.anchor)?.height ?? null;
  }
  const queue = log.ids.slice(start);
  return { did, sat: log.sat.did, committed: log.ids[log.ids.length - 1], accepted, acceptedHeight, next: queue[0] ?? null, queue, remaining: queue.length, publication, view };
}

const NETWORK: Record<string, string> = { mainnet: "mainnet", signet: "signet", testnet: "testnet", regtest: "regtest" };

/** Read the anchoring sat and compare what Bitcoin accepts with what is committed (P9.4, P9.13). */
export async function nextPendingEntry(sdk: OriginalsSDK, did: string, options: ReadAnchoredOptions): Promise<PendingEntries> {
  return (await observe(sdk, did, await storedLog(sdk, did), options)).pending;
}

/**
 * What Bitcoin will not hold for an Original, through one entry (P9.18): the
 * resource bytes, of which inscriptions carry only the descriptors (P9.4,
 * P9.17), and the DID histories of its did:vh and did:webvh signers. A
 * did:btco signer's history is on Bitcoin (P5.13) and listed in `onBitcoin`.
 * This profile does not guarantee their replication or availability: keep
 * them, publish them, or give them to the sat's next holder
 * (`transferHandoff`).
 */
export interface OffChainEvidence {
  original: string;
  /** The entry the notice runs through: the log from genesis to it. */
  through: string;
  /** Every resource version the log through `through` commits to; `held` when this SDK has the bytes and they match. */
  resources: Array<{ resource: string; version: number; digest: string; mediaType: string; size: number; versionId: string; held: boolean }>;
  /** Off-chain signer DIDs (did:vh, did:webvh), author first; `held` when this SDK has complete history for it. */
  identities: Array<{ did: string; role: "author" | "editor"; held: boolean }>;
  /** did:btco signer DIDs, whose histories Bitcoin carries. */
  onBitcoin: Array<{ did: string; role: "author" | "editor" }>;
  replication: "not-guaranteed";
}

function offChainOf(did: string, through: string, report: OriginalsReport): OffChainEvidence {
  const id = report.identityEvidence;
  const signers = [
    ...(id.author ? [{ did: id.author, role: "author" as const, held: id.latestVersionId !== null && !id.failure }] : []),
    ...id.editors.map((e) => ({ did: e.did, role: "editor" as const, held: e.status === "complete" })),
  ];
  return {
    original: did,
    through,
    resources: report.resources.versions.map((v) => ({
      resource: v.resource, version: v.version, digest: v.digest, mediaType: v.mediaType, size: v.size, versionId: v.versionId, held: v.bytes === "verified",
    })),
    identities: signers.filter((s) => !s.did.startsWith("did:btco:")),
    onBitcoin: signers.filter((s) => s.did.startsWith("did:btco:")).map(({ did: d, role }) => ({ did: d, role })),
    replication: "not-guaranteed",
  };
}

/** Reasons a fresh verification gives that Bitcoin would refuse the entry for (P9.15, P5.18). */
const REFUSED_ON_BITCOIN = new Set(["author-did-deactivated", "head-key-not-in-latest-author-document", "head-key-not-in-latest-signer-document"]);

/**
 * P9.18: before inscribing, verify the stored log through the entry as a fresh
 * reader of this SDK's evidence package would: history, author binding and the
 * identity evidence of every signer through it (author and editors), and the
 * signing key still valid in its signer's latest state. Resource availability
 * is reported (`offChain`), never a gate (P7.4). Freshness is a separate
 * policy and is not gated here.
 */
async function verifyThrough(sdk: OriginalsSDK, did: string, log: StoredLog, index: number): Promise<OffChainEvidence> {
  const versionId = log.ids[index];
  const code = index === log.anchor ? "ANCHORING_NOT_VERIFIED" : "ENTRY_NOT_VERIFIED";
  const what = index === log.anchor ? "the anchoring entry" : `entry ${versionId}`;
  let pkg: EvidencePackage;
  try {
    pkg = await sdk.package(did, { checkpoint: versionId });
  } catch (error) {
    if (!(error instanceof OriginalsError)) throw error;
    const report = (error.details as { report?: OriginalsReport } | undefined)?.report;
    const category = report?.history.failure?.category ?? error.category;
    refuse(category, code, `${did} does not verify through ${what}; not inscribed (P9.18): ${error.message}`, { cause: error.code, ...(report ? { report } : {}) });
  }
  const loaded: LoadedEvidence = await sdk.load(pkg.bytes);
  const r = loaded.report;
  const problems: string[] = [];
  if (r.history.status !== "valid" || r.checkpoint !== versionId) problems.push(`history-${r.history.status}`);
  if (r.authorBinding.status !== "valid") problems.push(`author-binding-${r.authorBinding.status}`);
  if (r.identityEvidence.status !== "complete") problems.push("identity-evidence-incomplete");
  for (const reason of r.reasons) if (REFUSED_ON_BITCOIN.has(reason)) problems.push(reason);
  if (problems.length > 0) {
    const category = problems.every((p) => p === "identity-evidence-incomplete") ? "incomplete-evidence" : r.history.failure?.category ?? "invalid-evidence";
    refuse(category, code, `${did} does not verify through ${what}; not inscribed (P9.18): ${problems.join(", ")}`, { problems, report: r });
  }
  return offChainOf(did, versionId, r);
}

export type EntryInscriptionParams = Omit<InscribeOnSatParams, "buildContent" | "recoveryStore"> & {
  sdk: OriginalsSDK;
  did: string;
  /** Inscription times for reading the sat first, to find the next entry (P9.13). */
  clock: InscriptionClock;
  /** Which index serves that read (P9.11). */
  index: string;
  /**
   * The stored entry to inscribe. Omitted, the next entry Bitcoin can accept.
   * Named, it must be that entry (HEAD_NOT_NEXT).
   */
  versionId?: string;
};

export interface PreparedEntryInscription {
  /** The entry this pair publishes: the anchoring entry, or the one entry after Bitcoin's head. */
  versionId: string;
  /** The entries the body carries, oldest first: genesis through the anchoring entry, or `[versionId]`. */
  carries: string[];
  /** The anchoring sat, as its did:btco alias. */
  sat: string;
  /** Committed entries after this one, still to publish. */
  remaining: number;
  /** What Bitcoin will not hold, through `versionId` (P9.18). */
  offChain: OffChainEvidence;
  prepared: PreparedInscriptionOnSat;
}

/** Build (not broadcast) the pair that publishes the next committed entry on the anchoring sat. */
export async function prepareEntryInscription(params: EntryInscriptionParams): Promise<PreparedEntryInscription> {
  const { sdk, did, clock, index: satIndex, versionId, ...rest } = params;
  const log = await storedLog(sdk, did);
  if (NETWORK[log.sat.network] !== params.network) {
    refuse("invalid-evidence", "NETWORK_MISMATCH", `${log.sat.did} is a ${log.sat.network} sat; the writer is on ${params.network}`);
  }
  // A log over the limit through the anchoring entry can never be anchored (P9.17).
  checkSize(log, log.anchor, bodyFor(log, log.anchor));
  const { pending } = await observe(sdk, did, log, { provider: params.provider, clock, index: satIndex });
  const target = versionId ?? pending.next;
  if (target === null) refuse("invalid-evidence", "NOTHING_TO_INSCRIBE", `Bitcoin already shows the committed head ${pending.committed}`);
  const index = log.ids.indexOf(target);
  if (index < 0) refuse("invalid-evidence", "ENTRY_NOT_STORED", `${target} is not in the stored log of ${did}`);
  if (target !== pending.next) {
    if (pending.accepted === null) refuse("invalid-evidence", "HEAD_NOT_NEXT", `Bitcoin does not show the anchor yet: inscribe the log through the anchoring entry ${pending.next} before ${target}`);
    if (!pending.queue.includes(target)) refuse("invalid-evidence", "HEAD_NOT_NEXT", `${target} is already inscribed on the anchoring sat`);
    refuse("invalid-evidence", "HEAD_NOT_NEXT", `${target} does not follow ${pending.accepted}, the head Bitcoin shows; inscribe ${pending.next} first`);
  }
  // The stored lines, verbatim: the signed bytes Bitcoin will carry (P9.6, P9.17).
  const content = bodyFor(log, index);
  checkSize(log, index, content);
  const offChain = await verifyThrough(sdk, did, log, index);
  const prepared = await prepareInscriptionOnSat({
    ...rest,
    buildContent: (satoshi) => {
      if (satoshi !== log.sat.sat) {
        refuse("invalid-evidence", "WRONG_SAT", `the first funding UTXO holds sat ${satoshi}, not the anchoring sat ${log.sat.sat}`);
      }
      // No metadata: an Originals inscription that carries any is rejected (P9.17).
      return Promise.resolve({ content, contentType: ORIGINALS_INSCRIPTION_TYPE });
    },
  });
  const carries = index === log.anchor ? log.ids.slice(0, index + 1) : [target];
  return { versionId: target, carries, sat: log.sat.did, remaining: pending.remaining - 1, offChain, prepared };
}

export interface CatchUpParams extends ReadAnchoredOptions {
  sdk: OriginalsSDK;
  did: string;
  recoveryStore: InscriptionRecoveryStore;
}

/** One step of publishing the committed entries Bitcoin does not show yet. */
export type CatchUpStep =
  /** Bitcoin shows the committed head. */
  | { action: "done"; pending: PendingEntries }
  /**
   * Prepare `versionId` (`prepareEntryInscription`) and submit it. `replaces`
   * lists confirmed inscriptions of the same body Bitcoin ignored (P9.13):
   * this pair is a replacement, not a retry of them.
   */
  | { action: "prepare"; versionId: string; replaces: string[]; pending: PendingEntries }
  /** Resume the recorded pair for `versionId` (`resumeInscriptionOnSat`): the same bytes, no new fee (P9.6). */
  | { action: "resume"; versionId: string; recoveryId: string; broadcast: InscriptionRecoveryRecord["broadcast"]; pending: PendingEntries }
  /**
   * The pair for `versionId` is out: wait for a block (`unconfirmed`), or for
   * the sat reader to index a confirmed reveal (`not-indexed`). Resuming the
   * same pair is always safe if it stalls; preparing another is not.
   */
  | { action: "wait-for-confirmation"; versionId: string; recoveryId: string; inscriptionId: string; reason: "unconfirmed" | "not-indexed"; pending: PendingEntries };

/** The bytes a prepared reveal inscribes, if it inscribes one Originals inscription without metadata. */
function inscribedBytes(prepared: PreparedInscriptionOnSat): Uint8Array | undefined {
  try {
    const reveal = btc.Transaction.fromRaw(hex.decode(prepared.revealTxHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    const witness = reveal.getInput(0).finalScriptWitness;
    const inscriptions = witness ? parseWitness(witness) : undefined;
    if (inscriptions?.length !== 1 || inscriptions[0].tags.contentType !== ORIGINALS_INSCRIPTION_TYPE || inscriptions[0].tags.metadata !== undefined) return undefined;
    return inscriptions[0].body;
  } catch {
    return undefined;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function isConfirmed(provider: ReadAnchoredOptions["provider"], txid: string): Promise<boolean> {
  try {
    return (await provider.getTransactionStatus(txid)).confirmed === true;
  } catch {
    return false;
  }
}

/** What the recovery store holds for the next inscription. */
type Recorded =
  | { kind: "wait"; record: InscriptionRecoveryRecord; reason: "unconfirmed" | "not-indexed" }
  | { kind: "pairs"; resumable: InscriptionRecoveryRecord[]; replaces: string[] };

async function recoveryIdsOf(store: InscriptionRecoveryStore, given?: Iterable<string>): Promise<Iterable<string>> {
  const ids = given ?? (await store.list?.());
  if (!ids) refuse("incomplete-evidence", "RECOVERY_IDS_REQUIRED", "the recovery store cannot list its records; pass recoveryIds");
  return ids;
}

/** The recorded pairs that inscribe exactly `content` on the anchoring sat, and which of them can still land. */
async function recorded(log: StoredLog, view: OriginalView, content: Uint8Array, provider: ReadAnchoredOptions["provider"], store: InscriptionRecoveryStore, ids: Iterable<string>): Promise<Recorded> {
  const ignored = new Set((view.report.anchoring?.ignored ?? []).map((i) => i.inscription));
  const holding = view.report.ownership?.output;
  const replaces: string[] = [];
  const resumable: InscriptionRecoveryRecord[] = [];
  for (const id of ids) {
    const record = await store.load(id);
    if (!record || record.recoveryId !== id) continue;
    const { prepared } = record;
    if (prepared.satoshi !== log.sat.sat || prepared.network !== NETWORK[log.sat.network]) continue;
    const body = inscribedBytes(prepared);
    if (!body || !sameBytes(body, content)) continue;
    if (await isConfirmed(provider, prepared.revealTxId)) {
      // Confirmed: Bitcoin either ignored it (a replacement is needed) or has not indexed it yet.
      if (ignored.has(prepared.inscriptionId)) {
        replaces.push(prepared.inscriptionId);
        continue;
      }
      return { kind: "wait", record, reason: "not-indexed" };
    }
    // A pair can still land only while the sat sits in its funding input or its own commit.
    const first = prepared.fundingUtxos[0];
    const live = !holding || [`${first.txid}:${first.vout}`, `${prepared.commitTxId}:0`, `${prepared.revealTxId}:0`].includes(holding);
    if (!live) continue;
    if (record.broadcast === "reveal_broadcast") return { kind: "wait", record, reason: "unconfirmed" };
    resumable.push(record);
  }
  return { kind: "pairs", resumable, replaces };
}

function publicationOf(view: OriginalView, found: Recorded | undefined): Publication {
  const status = view.report.anchoring?.status;
  if (status === "anchored") return "anchored";
  const inFlight = found?.kind === "wait" || (found?.kind === "pairs" && found.resumable.some((r) => r.broadcast !== "prepared"));
  if (inFlight) return "pending-bitcoin-acceptance";
  return status === "unverified" ? "unverified" : "not-anchored";
}

/** Read the sat, compare the heads, and, with a recovery store, find the next inscription's recorded pairs. */
async function observe(sdk: OriginalsSDK, did: string, log: StoredLog, options: ReadAnchoredOptions): Promise<{ view: OriginalView; pending: PendingEntries; found?: Recorded }> {
  const { recoveryStore, recoveryIds, ...read } = options;
  const ids = recoveryStore ? await recoveryIdsOf(recoveryStore, recoveryIds) : undefined;
  const view = await sdk.get(did, { bitcoin: [await readSat(log.sat, read)] });
  const base = pendingFrom(did, log, view, "not-anchored");
  const found = base.next !== null && recoveryStore && ids
    ? await recorded(log, view, bodyFor(log, log.ids.indexOf(base.next)), read.provider, recoveryStore, ids)
    : undefined;
  return { view, pending: { ...base, publication: publicationOf(view, found) }, ...(found ? { found } : {}) };
}

/**
 * Decide the next step of catching up, from a fresh read of the sat and the
 * recorded pairs. Call it again after each step: it re-reads the accepted head
 * every time, so a reorganisation re-derives the queue, and it never prepares
 * an entry while a pair for it is pending, nor one Bitcoin already accepts.
 * Before the anchor is accepted the next inscription is the log through the
 * anchoring entry; then each step is one entry, author's or editor's alike.
 */
export async function catchUp(params: CatchUpParams): Promise<CatchUpStep> {
  const { sdk, did, recoveryStore, recoveryIds, ...read } = params;
  const ids = await recoveryIdsOf(recoveryStore, recoveryIds);
  const log = await storedLog(sdk, did);
  const { pending, found } = await observe(sdk, did, log, { ...read, recoveryStore, recoveryIds: ids });
  if (pending.next === null || !found) return { action: "done", pending };
  const versionId = pending.next;
  if (found.kind === "wait") {
    const { record, reason } = found;
    return { action: "wait-for-confirmation", versionId, recoveryId: record.recoveryId, inscriptionId: record.prepared.inscriptionId, reason, pending };
  }
  const [resume] = found.resumable;
  if (resume) return { action: "resume", versionId, recoveryId: resume.recoveryId, broadcast: resume.broadcast, pending };
  return { action: "prepare", versionId, replaces: found.replaces, pending };
}

export interface ReadAnchoredOptions {
  provider: Pick<OrdinalsProvider, "getSatSnapshot" | "getTransactionStatus">;
  clock: InscriptionClock;
  /** Which index serves the sat read, reported as used (P9.11; `satEvidence`). */
  index: string;
  /**
   * The writer's recovery store, to label a broadcast anchor
   * `pending-bitcoin-acceptance` (P9.18). Omitted, a broadcast anchor Bitcoin
   * does not show yet reads as `not-anchored`.
   */
  recoveryStore?: InscriptionRecoveryStore;
  /**
   * The recovery ids (commit txids) of the pairs prepared for this Original
   * that the store still holds. Records for other entries or sats are skipped.
   * Omitted, the store's own `list()` is used, so a restarted process needs
   * nothing but the store; a store that cannot list needs them passed.
   */
  recoveryIds?: Iterable<string>;
}

/** A read of an anchored Original from its sat, labelled with the anchor's state on Bitcoin (P9.18). */
export type AnchoredView = OriginalView & { publication: Publication };

/** Read the anchoring sat and verify the Original against it (P9.12, P9.13, P9.18). */
export async function readAnchored(sdk: OriginalsSDK, did: string, options: ReadAnchoredOptions): Promise<AnchoredView> {
  const { view, pending } = await observe(sdk, did, await storedLog(sdk, did), options);
  return { ...view, publication: pending.publication };
}

/** One index's complete read of a sat, as verifier evidence. */
async function readSat(sat: StoredLog["sat"], options: Pick<ReadAnchoredOptions, "provider" | "clock" | "index">): Promise<SatEvidence> {
  if (!options.provider.getSatSnapshot) refuse("incomplete-evidence", "SAT_SNAPSHOT_UNSUPPORTED", "the provider cannot read a complete sat");
  const snapshot = await options.provider.getSatSnapshot(sat.sat);
  if (snapshot.network !== NETWORK[sat.network] || snapshot.sat !== sat.sat) {
    refuse("invalid-evidence", "NETWORK_MISMATCH", `the provider read sat ${snapshot.sat} on ${snapshot.network}, not ${sat.did}`);
  }
  const satpoint = snapshot.ownership.satpoint;
  const ownerConfirmations = satpoint ? (await options.provider.getTransactionStatus(satpoint.split(":")[0])).confirmations ?? 0 : 0;
  return satEvidence(snapshot, { clock: options.clock, ownerConfirmations, index: options.index });
}

/** What the sender of an anchoring sat gives its recipient (P9.18). */
export interface TransferHandoff {
  /**
   * An evidence package (P7.1) through `checkpoint` (default: the committed
   * head): the log, the DID histories of its did:vh and did:webvh signers and
   * the resource bytes this SDK holds. A did:btco signer's history is read
   * from Bitcoin and is listed in the manifest as missing.
   */
  package: EvidencePackage;
  /** What the package carries that Bitcoin does not, and whether this SDK held each. */
  offChain: OffChainEvidence;
}

/**
 * For the recipient of the anchoring sat: the resource bytes and off-chain
 * signer DID histories this SDK holds (P9.18 SHOULD). Transferring the sat
 * transfers the Original; this only hands over evidence, and nothing
 * guarantees its replication. The recipient's SDK should check it with
 * `verifyHandoff` against the sat rather than trust it.
 */
export async function transferHandoff(sdk: OriginalsSDK, did: string, options: { checkpoint?: string } = {}): Promise<TransferHandoff> {
  const pkg = await sdk.package(did, options);
  const loaded = await sdk.load(pkg.bytes);
  return { package: pkg, offChain: offChainOf(did, pkg.manifest.checkpoint, loaded.report) };
}

/**
 * The recipient's check of a handoff (P9.18): read the sat the package's log
 * names and verify the package against it, storing nothing. Bitcoin decides
 * the log (P9.17); the package supplies identity evidence and bytes, each
 * checked: history, author binding, identity evidence and resource
 * availability are reported separately in `report`.
 */
export async function verifyHandoff(sdk: OriginalsSDK, zip: Uint8Array, options: Pick<ReadAnchoredOptions, "provider" | "clock" | "index">): Promise<LoadedEvidence> {
  const { log, manifest } = readEvidence(zip);
  const { sat } = parseLines(manifest.original, log);
  return sdk.load(zip, { bitcoin: [await readSat(sat, options)] });
}
