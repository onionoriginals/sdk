/**
 * Writing an anchored Original to Bitcoin (plan 011 PR 10; plan 012).
 *
 * Three heads are kept apart:
 * - the committed head: the last entry of the stored log, signed locally;
 * - a prepared or pending publication: a pair in the recovery store, built or
 *   broadcast but not accepted, which never advances anything (P9.4). While
 *   the anchoring pair is observed on the network (confirmed, or in the
 *   node's mempool) but Bitcoin does not show it, reads are labelled
 *   `pending-bitcoin-acceptance` (P9.18); submitted but not observed, they
 *   are `submitted-unobserved` (P9.18 as originals-spec #51 (open, head b96841c2e), PROVISIONAL until it merges);
 * - the accepted head: the last entry Bitcoin shows on the anchoring sat
 *   under the 1-confirmation policy (decision D), read by `readAnchored`.
 *
 * What is inscribed (P9.17): the anchoring inscription carries the stored log
 * from genesis through the anchoring entry, exact stored lines in order, the
 * anchoring entry last; every later inscription carries exactly one entry,
 * the successor of the head Bitcoin accepts. Media type
 * `application/vnd.originals.vh+jsonl`, no metadata, at most 350,000 bytes
 * (`ORIGINALS_INSCRIPTION_MAX_BYTES`; P14.12, decided, D6; spec PR #50 (open)). Entries committed after
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
 *   With the recovery store, a pair for the same entry that can still land
 *   refuses a new one (PAIR_IN_FLIGHT) unless `replaces` names it (P9.6). The
 *   store must be passed, or `recoveryStore: null` to skip that guard
 *   explicitly (`inFlightGuard: "skipped"`); omitting it is refused
 *   (RECOVERY_STORE_REQUIRED).
 * - `submitEntryInscription` sends a prepared pair the first time: it checks
 *   again that the entry is the next one Bitcoin can accept, that no other
 *   pair for it can still land, and verifies the log through it (P9.18), then
 *   persists and broadcasts. `resumeEntryInscription` rebroadcasts a recorded
 *   pair only when `catchUp` says to resume exactly it.
 * - `submitPreparedInscriptionOnSat` and `resumeInscriptionOnSat`, re-exported
 *   from the sat builder, are the unchecked low-level calls: they persist and
 *   broadcast the stored bytes and know nothing of Originals. Use them only
 *   for a pair just checked, or to force a rebroadcast `catchUp` refuses. A
 *   replacement is a new `prepareEntryInscription`, never a silent re-sign
 *   (P9.6).
 * - `catchUp` is one step of publishing the queue: it re-reads Bitcoin, finds
 *   any recorded pair for the next inscription, and says whether to resume
 *   it, wait for it, prepare the next one, or stop. A pair can still land
 *   only while the sat read shows the sat in its funding input or its own
 *   outputs; among several, the one furthest along on the network is chosen,
 *   then the lowest recovery id. Before resuming, the log is verified through
 *   the entry again (P9.18), and a pair that no longer verifies is `refused`.
 *   Damaged records are skipped and reported (`recoveryIssues`). One
 *   inscription is in flight at a time, so each accepted publication lands at
 *   a strictly greater height (P9.13). Editor entries are published like
 *   author entries.
 * - `readAnchored` reads the sat back; a broadcast or pending transaction never
 *   advances the published boundary (P9.4). Every read can compare several
 *   indexes (`indexes`), as P9.10 recommends: inscriptions they disagree on
 *   are missing evidence, and catch-up waits for Bitcoin.
 * - `transferHandoff` and `verifyHandoff`: when the anchoring sat is
 *   transferred, the sender exports, through the head Bitcoin accepts, the
 *   resource bytes and off-chain signer DID histories it holds, and the
 *   recipient verifies them against the sat it received (P9.18). Nothing
 *   guarantees their replication.
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
import {
  INSCRIPTION_RECORD_STATES,
  resumeInscriptionOnSat,
  submitPreparedInscriptionOnSat,
  validatePreparedInscriptionOnSat,
  type InscriptionRecoveryRecord,
  type InscriptionRecoveryStore,
} from "../bitcoin/inscription-recovery.js";
import type { InscribeOnSatResult } from "../bitcoin/inscribe-on-sat.js";
import { readEvidence } from "./evidence.js";
import { InscriptionClock, satEvidence } from "./bitcoin.js";
import type { EvidencePackage, LoadedEvidence, OriginalView, OriginalsSDK } from "./sdk.js";

/**
 * The sat builder's unchecked low-level calls, re-exported: they persist and
 * broadcast stored bytes and know nothing of Originals. Prefer
 * `submitEntryInscription` and `resumeEntryInscription`, which check the
 * entry is still next and verify the log through it first (P9.6, P9.18).
 */
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
   * A recorded anchoring pair is observed on the network and Bitcoin does not
   * show it as the anchor yet: its commit or reveal is confirmed (including a
   * confirmed reveal not yet indexed) or, where the provider reports it
   * (`inMempool`), in the node's mempool. Its acceptance depends on its
   * position (P5.13, P9.15, P9.16), so it is not anchored yet.
   */
  | "pending-bitcoin-acceptance"
  /**
   * A recorded anchoring pair was submitted, but neither its commit nor its
   * reveal is observed: the node rejected or evicted it, or the provider
   * cannot see its mempool. Not pending acceptance: nothing shows Bitcoin has
   * it. `catchUp` says whether to resume the same pair (P9.6). PROVISIONAL:
   * P9.18 names one label, pending Bitcoin acceptance, until confirmation;
   * this splits off the case where nothing shows the network has the pair
   * (a spec question, see ORIGINALS.md).
   */
  | "submitted-unobserved"
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
  /**
   * Recovery records that could not be used: unreadable, damaged, or whose
   * declared identities do not match their bytes. Each is skipped and
   * reported here; one never blocks another Original's catch-up.
   */
  recoveryIssues: RecoveryIssue[];
  /** The read the comparison came from. */
  view: OriginalView;
}

/** A recovery record skipped because it could not be used. */
export interface RecoveryIssue {
  recoveryId: string;
  /** The store's or validator's code, e.g. RECOVERY_RECORD_DAMAGED, INVALID_INSCRIPTION_RECOVERY. */
  code: string;
  message: string;
}

function pendingFrom(did: string, log: StoredLog, view: OriginalView, publication: Publication): Omit<PendingEntries, "recoveryIssues"> {
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

/**
 * P9.18: before inscribing, verify the stored log through the entry as a fresh
 * reader of this SDK's evidence package would: history, author binding and the
 * identity evidence of every signer through it (author and editors), and the
 * entry not historically authorized only (P7.9). Resource availability
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
  // Bitcoin would refuse an entry that a fresh reader finds historically authorized only: its key
  // is no longer in its signer's latest DID state, its editor DID or the author DID is deactivated
  // (P7.9, P9.15, P5.18).
  const historical = r.historicallyAuthorizedOnly.find((h) => h.versionId === versionId);
  if (historical) problems.push(historical.reason);
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
  /**
   * The writer's recovery store (and, if it cannot list, `recoveryIds`):
   * a pair for the same entry that can still land refuses the new one
   * (PAIR_IN_FLIGHT): retrying it is `resumeEntryInscription`, not a second
   * pair (P9.6). Nothing is saved here; submitting saves. Required: pass
   * `null` to skip the guard deliberately (the result says
   * `inFlightGuard: "skipped"`); omitted, the call is refused
   * (RECOVERY_STORE_REQUIRED).
   */
  recoveryStore: InscriptionRecoveryStore | null;
  recoveryIds?: Iterable<string>;
  /** Further indexes whose reads of the sat are compared with `provider`'s (P9.10). */
  indexes?: SatIndexRead[];
  /**
   * The recovery ids (or inscription ids) of in-flight pairs this one
   * deliberately replaces (P9.6). Their inputs are the same sat-holding
   * output, so at most one of them lands.
   */
  replaces?: string[];
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
  /** `checked` with a recovery store; `skipped` when `recoveryStore: null` was passed (P9.6). */
  inFlightGuard: "checked" | "skipped";
  /**
   * The in-flight pairs this one deliberately replaces, as named when it was
   * prepared (P9.6). `submitEntryInscription` honours them, so the
   * replacement is not refused as PAIR_IN_FLIGHT at submit.
   */
  replaces: string[];
  prepared: PreparedInscriptionOnSat;
}

/** Build (not broadcast) the pair that publishes the next committed entry on the anchoring sat. */
export async function prepareEntryInscription(params: EntryInscriptionParams): Promise<PreparedEntryInscription> {
  const { sdk, did, clock, index: satIndex, versionId, recoveryStore, recoveryIds, replaces = [], indexes, ...rest } = params;
  if (recoveryStore === undefined) {
    refuse("invalid-evidence", "RECOVERY_STORE_REQUIRED", "pass the writer's recoveryStore, so a pair that can still land is not prepared twice (P9.6), or recoveryStore: null to skip that check deliberately");
  }
  const log = await storedLog(sdk, did);
  if (NETWORK[log.sat.network] !== params.network) {
    refuse("invalid-evidence", "NETWORK_MISMATCH", `${log.sat.did} is a ${log.sat.network} sat; the writer is on ${params.network}`);
  }
  // A log over the limit through the anchoring entry can never be anchored (P9.17).
  checkSize(log, log.anchor, bodyFor(log, log.anchor));
  const { pending, found, disagreement } = await observe(sdk, did, log, { provider: params.provider, clock, index: satIndex, ...(indexes ? { indexes } : {}), ...(recoveryStore ? { recoveryStore } : {}), ...(recoveryIds ? { recoveryIds } : {}) });
  refuseDisagreement(did, disagreement);
  const target = versionId ?? pending.next;
  if (target === null) refuse("invalid-evidence", "NOTHING_TO_INSCRIBE", `Bitcoin already shows the committed head ${pending.committed}`);
  const index = log.ids.indexOf(target);
  if (index < 0) refuse("invalid-evidence", "ENTRY_NOT_STORED", `${target} is not in the stored log of ${did}`);
  if (target !== pending.next) {
    if (pending.accepted === null) refuse("invalid-evidence", "HEAD_NOT_NEXT", `Bitcoin does not show the anchor yet: inscribe the log through the anchoring entry ${pending.next} before ${target}`);
    if (!pending.queue.includes(target)) refuse("invalid-evidence", "HEAD_NOT_NEXT", `${target} is already inscribed on the anchoring sat`);
    refuse("invalid-evidence", "HEAD_NOT_NEXT", `${target} does not follow ${pending.accepted}, the head Bitcoin shows; inscribe ${pending.next} first`);
  }
  // P9.6: a pair for this entry that can still land is retried, not replaced, unless the caller says so.
  const inFlight = (found?.inFlight ?? []).filter((c) => !replaces.includes(c.record.recoveryId) && !replaces.includes(c.record.prepared.inscriptionId));
  if (inFlight.length > 0) {
    const ids = inFlight.map((c) => c.record.recoveryId);
    refuse("stale-parent", "PAIR_IN_FLIGHT", `a recorded pair for ${target} can still land (${ids.join(", ")}); resume it, or name it in \`replaces\` to prepare a replacement (P9.6)`, { recoveryIds: ids });
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
  return { versionId: target, carries, sat: log.sat.did, remaining: pending.remaining - 1, offChain, inFlightGuard: recoveryStore ? "checked" : "skipped", replaces: [...replaces], prepared };
}

export interface SubmitEntryParams extends ReadAnchoredOptions {
  sdk: OriginalsSDK;
  did: string;
  /** The pair `prepareEntryInscription` returned. */
  pair: PreparedEntryInscription;
  /** The node that broadcasts. */
  provider: OrdinalsProvider;
  recoveryStore: InscriptionRecoveryStore;
  /**
   * Further recovery ids (or inscription ids) of in-flight pairs this one
   * deliberately replaces (P9.6), in addition to the pair's own `replaces`.
   */
  replaces?: string[];
}

/**
 * Send a prepared pair the first time, checked (P9.6, P9.18). Time passes
 * between preparing and sending, so it re-reads the sat: the entry must still
 * be the next one Bitcoin can accept (HEAD_NOT_NEXT), no other recorded pair
 * for it may be able to land (PAIR_IN_FLIGHT, unless `replaces` names it),
 * the pair must inscribe exactly the stored bytes (PAIR_BODY_MISMATCH), the
 * indexes read must agree (INDEXES_DISAGREE), the sat must still sit in the
 * pair's funding input (SAT_MOVED; SAT_HOLDER_UNKNOWN when neither the read nor
 * the funding output shows it), and the stored log must verify through the entry again
 * (ANCHORING_NOT_VERIFIED, ENTRY_NOT_VERIFIED). Then it persists and broadcasts, as
 * `submitPreparedInscriptionOnSat` does. Nothing is sent when it refuses.
 */
export async function submitEntryInscription(params: SubmitEntryParams): Promise<InscribeOnSatResult> {
  const { sdk, did, pair, provider, recoveryStore, ...read } = params;
  const replaces = [...(pair.replaces ?? []), ...(params.replaces ?? [])];
  const log = await storedLog(sdk, did);
  const index = log.ids.indexOf(pair.versionId);
  if (index < 0) refuse("invalid-evidence", "ENTRY_NOT_STORED", `${pair.versionId} is not in the stored log of ${did}`);
  const body = inscribedBytes(pair.prepared);
  if (!body || !sameBytes(body, bodyFor(log, index)) || pair.prepared.satoshi !== log.sat.sat) {
    refuse("invalid-evidence", "PAIR_BODY_MISMATCH", `the pair does not inscribe the stored bytes of ${pair.versionId} on ${log.sat.did}`);
  }
  const { pending, found, disagreement, holding } = await observe(sdk, did, log, { ...read, provider, recoveryStore });
  refuseDisagreement(did, disagreement);
  if (pending.next !== pair.versionId) {
    refuse("stale-parent", "HEAD_NOT_NEXT", `${pair.versionId} is not the next entry Bitcoin can accept (${pending.next ?? "none: Bitcoin shows the committed head"}); nothing is sent`);
  }
  await checkSatInPair(log, pair.prepared, holding, provider);
  const others = (found?.inFlight ?? []).filter((c) => c.record.recoveryId !== pair.prepared.commitTxId && !replaces.includes(c.record.recoveryId) && !replaces.includes(c.record.prepared.inscriptionId));
  if (others.length > 0) {
    const ids = others.map((c) => c.record.recoveryId);
    refuse("stale-parent", "PAIR_IN_FLIGHT", `another recorded pair for ${pair.versionId} can still land (${ids.join(", ")}); resume it, or name it in \`replaces\` (P9.6)`, { recoveryIds: ids });
  }
  await verifyThrough(sdk, did, log, index);
  return submitPreparedInscriptionOnSat({ prepared: pair.prepared, provider, recoveryStore });
}

/**
 * The pair spends the sat-holding output it was built on: if the sat has left
 * it (or the pair's own commit output), the pair cannot land (P9.6). The sat
 * read names the holder once the sat carries an inscription; before that (ord
 * reports no satpoint for a sat it has no inscription on) the funding output
 * itself is asked for its first sat, which an index refuses once it is spent.
 */
async function checkSatInPair(log: StoredLog, prepared: PreparedInscriptionOnSat, holding: string | undefined, provider: OrdinalsProvider): Promise<void> {
  const [funding, commit] = pairOutputs(prepared);
  if (holding !== undefined) {
    if (holding === funding || holding === commit) return;
    refuse("stale-parent", "SAT_MOVED", `${log.sat.did} is in ${holding}, not in the pair's funding input ${funding}; the pair cannot land, prepare another; nothing is sent`, { holding });
  }
  const first = prepared.fundingUtxos[0];
  let sat: string;
  try {
    if (!provider.getFirstSatOfOutput) throw new Error("the provider cannot read an output's sats");
    sat = await provider.getFirstSatOfOutput({ txid: first.txid, vout: first.vout });
  } catch (error) {
    refuse("incomplete-evidence", "SAT_HOLDER_UNKNOWN", `the read of ${log.sat.did} names no output holding the sat, and the pair's funding input ${funding} cannot be shown to hold it unspent (${error instanceof Error ? error.message : String(error)}); nothing is sent`);
  }
  if (sat !== log.sat.sat) {
    refuse("stale-parent", "SAT_MOVED", `the pair's funding input ${funding} holds sat ${sat}, not ${log.sat.did}; nothing is sent`, { holding: funding });
  }
}

export interface CatchUpParams extends ReadAnchoredOptions {
  sdk: OriginalsSDK;
  did: string;
  recoveryStore: InscriptionRecoveryStore;
}

/** How far a recorded pair's commit got, as the provider sees it now. */
export type CommitSeen = "confirmed" | "mempool" | "not-observed";

/** One step of publishing the committed entries Bitcoin does not show yet. */
export type CatchUpStep =
  /** Bitcoin shows the committed head. */
  | { action: "done"; pending: PendingEntries }
  /**
   * Prepare `versionId` (`prepareEntryInscription`) and submit it. `replaces`
   * lists confirmed inscriptions of the same body Bitcoin ignored for good
   * (P9.13): this pair is a replacement, not a retry of them. An inscription
   * the read shows unconfirmed or whose placement is disputed is not listed:
   * it is waited on.
   */
  | { action: "prepare"; versionId: string; replaces: string[]; pending: PendingEntries }
  /**
   * Resume the recorded pair for `versionId` (`resumeEntryInscription`, or
   * `resumeInscriptionOnSat`): the same bytes, no new fee (P9.6). The stored
   * log was verified through `versionId` again first (P9.18). Also returned
   * for a broadcast pair the provider reports in neither its mempool nor the
   * chain (evicted or rejected): the policy is to rebroadcast the same pair
   * on the first read that shows it absent, since resubmitting identical
   * bytes is idempotent and spends nothing new.
   */
  | { action: "resume"; versionId: string; recoveryId: string; broadcast: InscriptionRecoveryRecord["broadcast"]; pending: PendingEntries }
  /**
   * The pair for `versionId` is out: wait for a block (`unconfirmed`), or for
   * the sat reader to index a confirmed reveal (`not-indexed`). Resuming the
   * same pair is always safe if it stalls; preparing another is not.
   */
  | { action: "wait-for-confirmation"; versionId: string; recoveryId: string; inscriptionId: string; reason: "unconfirmed" | "not-indexed"; pending: PendingEntries }
  /**
   * The pair for `versionId` is confirmed on the sat, but this writer holds no
   * verified copy of the signer DID version the entry names
   * (`later-inscription-unverifiable`, P9.12, P9.15, P5.6): Bitcoin has not
   * ignored it, the reader cannot tell yet. Supply `signer`'s DID history
   * through `signerVersionId` and catch up again. Nothing is prepared over it,
   * since it may be accepted once that evidence is held (P9.6).
   */
  /**
   * Also when the pair waits on an earlier inscription extending the same
   * head that the writer cannot verify (`waiting-for-earlier-unverifiable`):
   * `waitingOn` names it, and `signer`/`signerVersionId` are what that one
   * needs. Chain order decides between them once it is verified (P9.15;
   * originals-spec #51 (open, head c6479e26e), PROVISIONAL until it merges).
   */
  | { action: "wait-for-evidence"; versionId: string; recoveryId: string; inscriptionId: string; signer: string; signerVersionId: string; waitingOn?: string; pending: PendingEntries }
  /**
   * The indexes disagree on what the sat holds (anchoring `unverified` or
   * `disputed` inscriptions, P9.10) or on which output holds it (`holders`,
   * each output named): nothing is prepared, submitted or resumed until they
   * agree, so a second anchor is never built on missing evidence and a pair
   * the sat may have left is never labelled resumable. The same disagreement
   * refuses `prepareEntryInscription` and `submitEntryInscription`
   * (INDEXES_DISAGREE).
   */
  | { action: "wait-for-bitcoin"; versionId: string; reason: "indexes-disagree"; disputed: string[]; holders: string[]; pending: PendingEntries }
  /**
   * A recorded pair for `versionId` can still land, but the stored log no
   * longer verifies through it (P9.18): nothing is broadcast. `commit` says
   * how far the pair got. With `not-observed` the record can be discarded.
   * With `mempool` or `confirmed` the sat is, or will be, in the commit's
   * output, which only this pair's reveal spends: broadcasting it would move
   * the sat but inscribe an entry that `ifRevealed` says Bitcoin ignores
   * (P9.15) or that cannot be verified with the evidence held. Only an
   * explicit `resumeInscriptionOnSat` broadcasts it.
   */
  | { action: "refused"; versionId: string; recoveryId: string; commit: CommitSeen; ifRevealed: "ignored-by-bitcoin" | "unverified"; error: OriginalsError; pending: PendingEntries };

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

/** Where the provider sees a transaction: `unknown` when it cannot say (no mempool view, or an error). */
type Seen = "confirmed" | "mempool" | "absent" | "unknown";

async function seen(provider: ReadAnchoredOptions["provider"], txid: string): Promise<Seen> {
  try {
    const status = await provider.getTransactionStatus(txid);
    if (status.confirmed === true) return "confirmed";
    return status.inMempool === true ? "mempool" : status.inMempool === false ? "absent" : "unknown";
  } catch {
    return "unknown";
  }
}

interface Candidate {
  record: InscriptionRecoveryRecord;
  commit: Seen;
  reveal: Seen;
  /** For a confirmed pair the read cannot verify yet: the signer DID version it lacks. */
  unverifiable?: { signer: string; signerVersionId: string };
  /** The earlier unverifiable inscription this one waits on, if any (P9.15). */
  waitingOn?: string;
}

/** What the recovery store holds for the next inscription. */
interface Recorded {
  /** Pairs whose reveal is confirmed but which the read does not show placed yet: wait for the index. */
  indexed: Candidate[];
  /** Pairs that can still land (the sat sits in their funding input or their own outputs), best first. */
  live: Candidate[];
  /** `indexed` and `live`: every pair for this entry that can still land. */
  inFlight: Candidate[];
  /** Confirmed inscriptions of this body that Bitcoin ignored for good. */
  replaces: string[];
  issues: RecoveryIssue[];
}

async function recoveryIdsOf(store: InscriptionRecoveryStore, given?: Iterable<string>): Promise<string[]> {
  const ids = given ?? (await store.list?.());
  if (!ids) refuse("incomplete-evidence", "RECOVERY_IDS_REQUIRED", "the recovery store cannot list its records; pass recoveryIds");
  return [...new Set(ids)].sort();
}

/**
 * Ignored reasons that are not final: the inscription may still be accepted
 * once confirmed, agreed on, or verified with the signer DID version it names
 * (`later-inscription-unverifiable`: the reader lacks that evidence, P9.12,
 * P9.15, P5.6). Catch-up waits on these and never prepares a replacement.
 */
const NOT_SETTLED = new Set(["unconfirmed", "placement-disputed", "after-disputed-placement", "later-inscription-unverifiable", "waiting-for-earlier-unverifiable"]);

/** Ordering of live pairs: the one furthest along on the network first, then by recovery id. */
const PROGRESS: Record<InscriptionRecoveryRecord["broadcast"], number> = {
  reveal_broadcast: 0, reveal_broadcast_unknown: 1, commit_broadcast: 2, commit_broadcast_unknown: 3, prepared: 4,
};
const rank = (c: Candidate) => (c.reveal === "mempool" ? 0 : c.commit === "confirmed" ? 1 : c.commit === "mempool" ? 2 : 3 + PROGRESS[c.record.broadcast]);

/** Load one record, or report why it cannot be used (never a bare TypeError). */
async function loadRecord(store: InscriptionRecoveryStore, id: string): Promise<InscriptionRecoveryRecord | RecoveryIssue | undefined> {
  const issue = (code: string, message: string): RecoveryIssue => ({ recoveryId: id, code, message });
  let record: InscriptionRecoveryRecord | undefined;
  try {
    record = await store.load(id);
  } catch (error) {
    return issue((error as { code?: string }).code ?? "RECOVERY_RECORD_UNREADABLE", error instanceof Error ? error.message : String(error));
  }
  if (record === undefined || record === null) return undefined;
  if (typeof record !== "object" || record.recoveryId !== id) return issue("RECOVERY_RECORD_MISMATCH", `the record stored under ${id} names another recovery id`);
  try {
    validatePreparedInscriptionOnSat(record.prepared);
  } catch (error) {
    return issue((error as { code?: string }).code ?? "INVALID_INSCRIPTION_RECOVERY", error instanceof Error ? error.message : String(error));
  }
  if (record.prepared.commitTxId !== id) return issue("RECOVERY_RECORD_MISMATCH", `the record stored under ${id} holds the pair committed by ${record.prepared.commitTxId}`);
  if (!INSCRIPTION_RECORD_STATES.includes(record.broadcast)) return issue("INVALID_INSCRIPTION_RECOVERY", `the record ${id} is in an unknown state`);
  return record;
}

/**
 * The recorded pairs that inscribe exactly `content` on the anchoring sat, and
 * which of them can still land. `holding` is the outpoint holding the sat now,
 * from the sat read itself (not from verified ownership, which is null before
 * the anchor is accepted).
 */
async function recorded(log: StoredLog, view: OriginalView, holding: string | undefined, content: Uint8Array, provider: ReadAnchoredOptions["provider"], store: InscriptionRecoveryStore, ids: string[]): Promise<Recorded> {
  const ignored = new Set((view.report.anchoring?.ignored ?? []).filter((i) => !NOT_SETTLED.has(i.reason)).map((i) => i.inscription));
  const unverifiable = new Map((view.report.anchoring?.unverifiable ?? []).map((u) => [u.inscription, { signer: u.signer, signerVersionId: u.signerVersionId }]));
  const waiting = new Map((view.report.anchoring?.ignored ?? []).flatMap((i) => (i.reason === "waiting-for-earlier-unverifiable" && i.waitingOn ? [[i.inscription, i.waitingOn] as const] : [])));
  const found: Recorded = { indexed: [], live: [], inFlight: [], replaces: [], issues: [] };
  for (const id of ids) {
    const loaded = await loadRecord(store, id);
    if (!loaded) continue;
    if (!("prepared" in loaded)) {
      found.issues.push(loaded);
      continue;
    }
    const record = loaded;
    const { prepared } = record;
    if (prepared.satoshi !== log.sat.sat || prepared.network !== NETWORK[log.sat.network]) continue;
    const body = inscribedBytes(prepared);
    if (!body || !sameBytes(body, content)) continue;
    const reveal = await seen(provider, prepared.revealTxId);
    if (reveal === "confirmed") {
      // Confirmed: Bitcoin either ignored it for good (a replacement is needed) or has not placed it yet.
      if (ignored.has(prepared.inscriptionId)) found.replaces.push(prepared.inscriptionId);
      else {
        const waitingOn = waiting.get(prepared.inscriptionId);
        const missing = unverifiable.get(prepared.inscriptionId) ?? (waitingOn ? unverifiable.get(waitingOn) : undefined);
        found.indexed.push({ record, commit: "confirmed", reveal, ...(missing ? { unverifiable: missing } : {}), ...(waitingOn ? { waitingOn } : {}) });
      }
      continue;
    }
    // A pair can still land only while the sat sits in its funding input or its own outputs.
    // `holding` is undefined only for a single read naming no holder: indexes that disagree on it stop catch-up first.
    if (holding !== undefined && !pairOutputs(prepared).includes(holding)) continue;
    found.live.push({ record, commit: await seen(provider, prepared.commitTxId), reveal });
  }
  found.live.sort((a, b) => rank(a) - rank(b) || (a.record.recoveryId < b.record.recoveryId ? -1 : 1));
  found.inFlight = [...found.indexed, ...found.live];
  return found;
}

/** The outputs a pair's sat passes through: its funding input, its commit output, its reveal output. */
function pairOutputs(prepared: PreparedInscriptionOnSat): string[] {
  const first = prepared.fundingUtxos[0];
  return [`${first.txid.toLowerCase()}:${first.vout}`, `${prepared.commitTxId.toLowerCase()}:0`, `${prepared.revealTxId.toLowerCase()}:0`];
}

/** What the indexes read disagree on (P9.10); undefined when they agree. */
interface Disagreement {
  /** Inscriptions whose placement the indexes disagree on. */
  disputed: string[];
  /** The outputs the indexes say hold the sat, when they name different ones (sorted); empty when they agree. */
  holders: string[];
}

function disagreementOf(view: OriginalView, holders: string[]): Disagreement | undefined {
  const anchoring = view.report.anchoring;
  const disputed = anchoring?.disputed ?? [];
  if (disputed.length === 0 && anchoring?.status !== "unverified" && holders.length === 0) return undefined;
  return { disputed, holders };
}

/** The guard every step that can broadcast shares: refuse while the indexes disagree (P9.6, P9.10). */
function refuseDisagreement(did: string, disagreement: Disagreement | undefined): void {
  if (!disagreement) return;
  const what = [
    ...(disagreement.disputed.length > 0 ? [`the placement of ${disagreement.disputed.join(", ")}`] : []),
    ...(disagreement.holders.length > 0 ? [`the sat's holder (${disagreement.holders.join(" / ")})`] : []),
  ];
  refuse("incomplete-evidence", "INDEXES_DISAGREE", `the indexes read disagree on ${what.length > 0 ? what.join(" and ") : "the anchor"} of ${did}; nothing is prepared or sent until they agree (P9.10)`, { ...disagreement });
}

const observed = (c: Candidate) => c.commit === "confirmed" || c.commit === "mempool" || c.reveal === "mempool";

function publicationOf(view: OriginalView, found: Recorded | undefined): Publication {
  const status = view.report.anchoring?.status;
  if (status === "anchored") return "anchored";
  if (found && (found.indexed.length > 0 || found.live.some(observed))) return "pending-bitcoin-acceptance";
  if (found?.live.some((c) => c.record.broadcast !== "prepared")) return "submitted-unobserved";
  return status === "unverified" ? "unverified" : "not-anchored";
}

/** Read the sat, compare the heads, and, with a recovery store, find the next inscription's recorded pairs. */
async function observe(sdk: OriginalsSDK, did: string, log: StoredLog, options: ReadAnchoredOptions): Promise<{ view: OriginalView; pending: PendingEntries; found?: Recorded; disagreement?: Disagreement; holding?: string }> {
  const { recoveryStore, recoveryIds, ...read } = options;
  const ids = recoveryStore ? await recoveryIdsOf(recoveryStore, recoveryIds) : undefined;
  const { evidence, holding, holders } = await readSatHeld(log.sat, read);
  const view = await sdk.get(did, { bitcoin: evidence });
  const base = pendingFrom(did, log, view, "not-anchored");
  const found = base.next !== null && recoveryStore && ids
    ? await recorded(log, view, holding, bodyFor(log, log.ids.indexOf(base.next)), read.provider, recoveryStore, ids)
    : undefined;
  const disagreement = disagreementOf(view, holders);
  return {
    view, pending: { ...base, publication: publicationOf(view, found), recoveryIssues: found?.issues ?? [] },
    ...(found ? { found } : {}), ...(disagreement ? { disagreement } : {}), ...(holding !== undefined ? { holding } : {}),
  };
}

/**
 * Decide the next step of catching up, from a fresh read of the sat and the
 * recorded pairs. Call it again after each step: it re-reads the accepted head
 * every time, so a reorganisation re-derives the queue, and it never prepares
 * an entry while a pair for it can still land, nor one Bitcoin already
 * accepts. Before the anchor is accepted the next inscription is the log
 * through the anchoring entry; then each step is one entry, author's or
 * editor's alike. Damaged recovery records are skipped and listed in
 * `pending.recoveryIssues`.
 */
export async function catchUp(params: CatchUpParams): Promise<CatchUpStep> {
  const { sdk, did, recoveryStore, recoveryIds, ...read } = params;
  const ids = await recoveryIdsOf(recoveryStore, recoveryIds);
  const log = await storedLog(sdk, did);
  const { pending, found, disagreement } = await observe(sdk, did, log, { ...read, recoveryStore, recoveryIds: ids });
  if (pending.next === null || !found) return { action: "done", pending };
  const versionId = pending.next;
  // P9.10: while the indexes disagree, nothing is prepared or resumed (the same guard refuses prepare and submit).
  if (disagreement) return { action: "wait-for-bitcoin", versionId, reason: "indexes-disagree", ...disagreement, pending };
  const [indexed] = found.indexed;
  if (indexed?.unverifiable) {
    const { signer, signerVersionId } = indexed.unverifiable;
    const waitingOn = indexed.waitingOn ? { waitingOn: indexed.waitingOn } : {};
    return { action: "wait-for-evidence", versionId, recoveryId: indexed.record.recoveryId, inscriptionId: indexed.record.prepared.inscriptionId, signer, signerVersionId, ...waitingOn, pending };
  }
  if (indexed) {
    return { action: "wait-for-confirmation", versionId, recoveryId: indexed.record.recoveryId, inscriptionId: indexed.record.prepared.inscriptionId, reason: "not-indexed", pending };
  }
  const [best] = found.live;
  if (best) {
    const { record } = best;
    // In the mempool, or reported broadcast by a provider that cannot see its mempool: wait.
    if (best.reveal === "mempool" || (record.broadcast === "reveal_broadcast" && best.reveal === "unknown")) {
      return { action: "wait-for-confirmation", versionId, recoveryId: record.recoveryId, inscriptionId: record.prepared.inscriptionId, reason: "unconfirmed", pending };
    }
    // P9.18: the log is verified through the entry again before its pair is broadcast, as when it was prepared.
    try {
      await verifyThrough(sdk, did, log, log.ids.indexOf(versionId));
    } catch (error) {
      if (!(error instanceof OriginalsError)) throw error;
      const commit: CommitSeen = best.commit === "confirmed" || best.commit === "mempool" ? best.commit : "not-observed";
      const ifRevealed = error.category === "incomplete-evidence" ? "unverified" : "ignored-by-bitcoin";
      return { action: "refused", versionId, recoveryId: record.recoveryId, commit, ifRevealed, error, pending };
    }
    return { action: "resume", versionId, recoveryId: record.recoveryId, broadcast: record.broadcast, pending };
  }
  return { action: "prepare", versionId, replaces: found.replaces, pending };
}

/**
 * Resume a recorded pair only when `catchUp` says to resume exactly it: the
 * log is verified through its entry again (P9.18), the pair can still land,
 * and it is the one chosen among the recorded pairs. Otherwise refused with
 * NOT_RESUMABLE (details carry the step). `resumeInscriptionOnSat` remains
 * the unchecked rebroadcast of stored bytes.
 */
export async function resumeEntryInscription(params: CatchUpParams & { recoveryId: string; provider: OrdinalsProvider }): Promise<InscribeOnSatResult> {
  const step = await catchUp(params);
  if (step.action !== "resume" || step.recoveryId !== params.recoveryId) {
    const details = step.action === "refused"
      ? { step: step.action, cause: step.error.code, commit: step.commit, ifRevealed: step.ifRevealed }
      : { step: step.action, ...("recoveryId" in step ? { chosen: step.recoveryId } : {}) };
    refuse(step.action === "refused" ? step.error.category : "stale-parent", "NOT_RESUMABLE", `catch-up does not resume ${params.recoveryId} (${step.action}${step.action === "refused" ? `: ${step.error.code}` : ""})`, details);
  }
  return resumeInscriptionOnSat({ recoveryId: params.recoveryId, provider: params.provider, recoveryStore: params.recoveryStore });
}

/** One more index's read of the sat (P9.10, P9.11). */
export interface SatIndexRead {
  provider: Pick<OrdinalsProvider, "getSatSnapshot" | "getTransactionStatus">;
  /** Which index serves it, reported as used. */
  index: string;
}

export interface ReadAnchoredOptions {
  provider: Pick<OrdinalsProvider, "getSatSnapshot" | "getTransactionStatus">;
  clock: InscriptionClock;
  /** Which index serves the sat read, reported as used (P9.11; `satEvidence`). */
  index: string;
  /**
   * Further independent indexes to read the sat from (P9.10 SHOULD: one you
   * run yourself, or two independent ones). Every read is compared: an
   * inscription they place differently is missing evidence, an anchor they
   * disagree on leaves the Original `unverified`, and `catchUp` waits for
   * Bitcoin (`wait-for-bitcoin`) instead of preparing. `provider` stays the
   * node that reports transactions.
   */
  indexes?: SatIndexRead[];
  /**
   * The writer's recovery store, to label a broadcast anchor
   * `pending-bitcoin-acceptance` or `submitted-unobserved` (P9.18). Omitted,
   * a broadcast anchor Bitcoin does not show yet reads as `not-anchored`.
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
export type AnchoredView = OriginalView & { publication: Publication; recoveryIssues: RecoveryIssue[] };

/** Read the anchoring sat and verify the Original against it (P9.12, P9.13, P9.18). */
export async function readAnchored(sdk: OriginalsSDK, did: string, options: ReadAnchoredOptions): Promise<AnchoredView> {
  const { view, pending } = await observe(sdk, did, await storedLog(sdk, did), options);
  return { ...view, publication: pending.publication, recoveryIssues: pending.recoveryIssues };
}

type SatReadOptions = Pick<ReadAnchoredOptions, "provider" | "clock" | "index" | "indexes">;

/** Every index's complete read of a sat, as verifier evidence. */
async function readSat(sat: StoredLog["sat"], options: SatReadOptions): Promise<SatEvidence[]> {
  return (await readSatHeld(sat, options)).evidence;
}

/**
 * The reads as evidence, one per index, and the outpoint they say holds the
 * sat now (whether or not an anchor is accepted); none when they disagree,
 * and then `holders` names each.
 */
async function readSatHeld(sat: StoredLog["sat"], options: SatReadOptions): Promise<{ evidence: SatEvidence[]; holding?: string; holders: string[] }> {
  const reads: SatIndexRead[] = [{ provider: options.provider, index: options.index }, ...(options.indexes ?? [])];
  const evidence: SatEvidence[] = [];
  const holdings = new Set<string | undefined>();
  for (const { provider, index } of reads) {
    if (!provider.getSatSnapshot) refuse("incomplete-evidence", "SAT_SNAPSHOT_UNSUPPORTED", `the provider for ${index} cannot read a complete sat`);
    // An asset read: only Originals bodies are fetched, so the holder's other inscriptions cost none (P9.12).
    const snapshot = await provider.getSatSnapshot(sat.sat, { bodies: "originals" });
    if (snapshot.network !== NETWORK[sat.network] || snapshot.sat !== sat.sat) {
      refuse("invalid-evidence", "NETWORK_MISMATCH", `${index} read sat ${snapshot.sat} on ${snapshot.network}, not ${sat.did}`);
    }
    const satpoint = snapshot.ownership.satpoint;
    const ownerConfirmations = satpoint ? (await provider.getTransactionStatus(satpoint.split(":")[0])).confirmations ?? 0 : 0;
    evidence.push(await satEvidence(snapshot, { clock: options.clock, ownerConfirmations, index }));
    holdings.add(satpoint ? satpoint.split(":").slice(0, 2).join(":").toLowerCase() : undefined);
  }
  const [holding] = holdings;
  // Reads that name different holders (or one names none) disagree: `holders` lists them for the guard.
  const holders = holdings.size > 1 ? [...holdings].map((h) => h ?? "none").sort() : [];
  return { evidence, holders, ...(holdings.size === 1 && holding !== undefined ? { holding } : {}) };
}

/** What the sender of an anchoring sat gives its recipient (P9.18). */
export interface TransferHandoff {
  /**
   * An evidence package (P7.1) through the head Bitcoin accepts (or the
   * committed head, or an exact checkpoint, when asked): the log, the DID
   * histories of its did:vh and did:webvh signers and the resource bytes this
   * SDK holds. A did:btco signer's history is read from Bitcoin and is listed
   * in the manifest as missing.
   */
  package: EvidencePackage;
  /** What the package carries that Bitcoin does not, and whether this SDK held each. */
  offChain: OffChainEvidence;
}

/**
 * Through which head a handoff runs. By default the head Bitcoin accepts,
 * read from the sat with these options: entries committed locally but not
 * inscribed are not the recipient's Original (P9.12) and stay out.
 * `{ through: "committed" }` hands over the committed head instead (entries
 * Bitcoin does not show yet included, for a recipient who will inscribe
 * them), and `{ checkpoint }` an exact entry.
 */
export type TransferHandoffOptions = (SatReadOptions & { through?: "accepted" }) | { through: "committed" } | { checkpoint: string };

/**
 * For the recipient of the anchoring sat: the resource bytes and off-chain
 * signer DID histories this SDK holds (P9.18 SHOULD), through the head
 * Bitcoin accepts unless asked otherwise (`TransferHandoffOptions`).
 * Transferring the sat transfers the Original; this only hands over evidence,
 * and nothing guarantees its replication. The recipient's SDK should check it
 * with `verifyHandoff` against the sat it received rather than trust it.
 */
export async function transferHandoff(sdk: OriginalsSDK, did: string, options?: TransferHandoffOptions): Promise<TransferHandoff> {
  const SAT_READ_REQUIRED = "a handoff runs through the head Bitcoin accepts: pass the sat read (provider, clock, index), or through: \"committed\", or { checkpoint }";
  // Called without options (from JavaScript, or with none at all): a structured refusal, not a TypeError.
  if (options === undefined || options === null || typeof options !== "object") refuse("incomplete-evidence", "SAT_READ_REQUIRED", SAT_READ_REQUIRED);
  let checkpoint: string | undefined;
  if ("checkpoint" in options) checkpoint = options.checkpoint;
  else if (options.through !== "committed") {
    if (!("provider" in options) || !options.provider) {
      refuse("incomplete-evidence", "SAT_READ_REQUIRED", SAT_READ_REQUIRED);
    }
    const pending = await nextPendingEntry(sdk, did, options);
    if (pending.accepted === null) {
      refuse("incomplete-evidence", "NOT_ANCHORED_ON_BITCOIN", `Bitcoin does not show ${did}'s anchor on ${pending.sat} (${pending.view.report.anchoring?.status ?? "unverified"}): there is no accepted head to hand over`);
    }
    checkpoint = pending.accepted;
  }
  const pkg = await sdk.package(did, checkpoint === undefined ? {} : { checkpoint });
  const loaded = await sdk.load(pkg.bytes);
  return { package: pkg, offChain: offChainOf(did, pkg.manifest.checkpoint, loaded.report) };
}

/**
 * The recipient's check of a handoff (P9.18): read the sat it received
 * (`expectedSat`, its did:btco alias) and verify the package against it,
 * storing nothing. A package whose log anchors to another sat is refused
 * (HANDOFF_SAT_MISMATCH): it is not the Original the recipient holds. Bitcoin
 * decides the log (P9.17); the package supplies identity evidence and bytes,
 * each checked: history, author binding, identity evidence and resource
 * availability are reported separately in `report`. Ownership is the sat's
 * holder (P9.11): compare `report.ownership.output` with the output the sat
 * was received in, and `report.ownership.confirmations` with your policy.
 */
export async function verifyHandoff(sdk: OriginalsSDK, zip: Uint8Array, options: SatReadOptions & { expectedSat: string }): Promise<LoadedEvidence> {
  const expected = parseBtcoAlias(options.expectedSat);
  const { log, manifest } = readEvidence(zip);
  const { sat } = parseLines(manifest.original, log);
  if (sat.did !== expected.did) {
    refuse("invalid-evidence", "HANDOFF_SAT_MISMATCH", `the package anchors ${manifest.original} to ${sat.did}, not ${expected.did}, the sat received`);
  }
  return sdk.load(zip, { bitcoin: await readSat(sat, options) });
}
