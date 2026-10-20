/**
 * Writing an anchored Original to Bitcoin (plan 011 PR 10; plan 012).
 *
 * Three heads are kept apart:
 * - the committed head: the last entry of the stored log, signed locally;
 * - a prepared or pending publication: a pair in the recovery store, built or
 *   broadcast but not accepted, which never advances anything (P9.4);
 * - the accepted head: the last entry Bitcoin shows on the anchoring sat
 *   under the 1-confirmation policy (decision D), read by `readAnchored`.
 *
 * - `nextPendingEntry` compares them: the entries from the next one Bitcoin
 *   can accept to the committed head. That is the anchoring entry until
 *   Bitcoin shows the anchor, then the successor of the accepted head (P9.13).
 * - `prepareEntryInscription` builds the commit and reveal that inscribe one
 *   stored entry, verbatim, on the anchoring sat, as one complete entry of
 *   `application/vnd.originals.vh+jsonl` (owner decision Q15): by default the
 *   next entry, or an explicit `versionId`, refused unless it is next
 *   (HEAD_NOT_NEXT). The first funding UTXO must hold the sat at offset 0: the
 *   anchoring sat for the anchoring entry (P9.10), and the output now holding
 *   it for every later entry, which is how only the sat's holder can extend an
 *   anchored Original while only the author can sign it (P9.12). Nothing is
 *   re-signed or rebased: the entry is the one already committed (P9.6).
 * - Submitting and retrying are the sat builder's durable state machine:
 *   `submitPreparedInscriptionOnSat` persists before every broadcast, and
 *   `resumeInscriptionOnSat` rebroadcasts the same pair. A replacement is a
 *   new `prepareEntryInscription`, never a silent re-sign (P9.6).
 * - `catchUp` is one step of publishing the queue: it re-reads Bitcoin, finds
 *   any recorded pair for the next entry, and says whether to resume it, wait
 *   for it, prepare the next entry, or stop. One entry is in flight at a time,
 *   so each accepted publication lands at a strictly greater height (P9.13).
 * - `readAnchored` reads the sat back; a broadcast or pending transaction never
 *   advances the published boundary (P9.4).
 */
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { parseWitness } from "micro-ordinals";
import { OriginalsError } from "@originals/vh";
import { ORIGINALS_INSCRIPTION_TYPE, anchoringIndex, parseBtcoAlias } from "@originals/vh/originals";
import type { OrdinalsProvider } from "../adapters/types.js";
import { prepareInscriptionOnSat, type InscribeOnSatParams, type PreparedInscriptionOnSat } from "../bitcoin/inscribe-on-sat.js";
import type { InscriptionRecoveryRecord, InscriptionRecoveryStore } from "../bitcoin/inscription-recovery.js";
import { readEvidence } from "./evidence.js";
import { InscriptionClock, satEvidence } from "./bitcoin.js";
import type { OriginalView, OriginalsSDK } from "./sdk.js";

export { submitPreparedInscriptionOnSat, resumeInscriptionOnSat } from "../bitcoin/inscribe-on-sat.js";

function refuse(category: "invalid-evidence" | "incomplete-evidence" | "stale-parent", code: string, message: string): never {
  throw new OriginalsError(category, code, message);
}

interface StoredLog {
  /** The stored log's lines, oldest first, exactly as signed. */
  lines: string[];
  ids: string[];
  /** The index of the anchoring entry. */
  anchor: number;
  sat: ReturnType<typeof parseBtcoAlias>;
}

/** The Original's stored log and the anchoring sat it names (P9.10). */
async function storedLog(sdk: OriginalsSDK, did: string): Promise<StoredLog> {
  const { log } = readEvidence((await sdk.package(did)).bytes);
  const lines = log.trimEnd().split("\n");
  const entries = lines.map((l) => JSON.parse(l) as { versionId: string; state: { asset: { aliases: string[] } } });
  const anchor = anchoringIndex(entries);
  const alias = anchor >= 0 ? entries[anchor].state.asset.aliases.find((a) => a.startsWith("did:btco:")) : undefined;
  if (!alias) refuse("invalid-evidence", "NOT_ANCHORED", `${did} has no anchoring entry; anchor it first (P9.10)`);
  return { lines, ids: entries.map((e) => e.versionId), anchor, sat: parseBtcoAlias(alias) };
}

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
  /** The read the comparison came from. */
  view: OriginalView;
}

function pendingFrom(did: string, log: StoredLog, view: OriginalView): PendingEntries {
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
  return { did, sat: log.sat.did, committed: log.ids[log.ids.length - 1], accepted, acceptedHeight, next: queue[0] ?? null, queue, remaining: queue.length, view };
}

const NETWORK: Record<string, string> = { mainnet: "mainnet", signet: "signet", testnet: "testnet", regtest: "regtest" };

/** Read the anchoring sat and compare what Bitcoin accepts with what is committed (P9.4, P9.13). */
export async function nextPendingEntry(sdk: OriginalsSDK, did: string, options: ReadAnchoredOptions): Promise<PendingEntries> {
  const log = await storedLog(sdk, did);
  return pendingFrom(did, log, await readSat(sdk, did, log, options));
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
  /** The entry this pair inscribes. */
  versionId: string;
  /** The anchoring sat, as its did:btco alias. */
  sat: string;
  /** Committed entries after this one, still to publish. */
  remaining: number;
  prepared: PreparedInscriptionOnSat;
}

/** Build (not broadcast) the pair that inscribes the next committed entry on the anchoring sat. */
export async function prepareEntryInscription(params: EntryInscriptionParams): Promise<PreparedEntryInscription> {
  const { sdk, did, clock, index: satIndex, versionId, ...rest } = params;
  const log = await storedLog(sdk, did);
  if (NETWORK[log.sat.network] !== params.network) {
    refuse("invalid-evidence", "NETWORK_MISMATCH", `${log.sat.did} is a ${log.sat.network} sat; the writer is on ${params.network}`);
  }
  const pending = pendingFrom(did, log, await readSat(sdk, did, log, { provider: params.provider, clock, index: satIndex }));
  const target = versionId ?? pending.next;
  if (target === null) refuse("invalid-evidence", "NOTHING_TO_INSCRIBE", `Bitcoin already shows the committed head ${pending.committed}`);
  const index = log.ids.indexOf(target);
  if (index < 0) refuse("invalid-evidence", "ENTRY_NOT_STORED", `${target} is not in the stored log of ${did}`);
  if (target !== pending.next) {
    if (pending.accepted === null) refuse("invalid-evidence", "HEAD_NOT_NEXT", `Bitcoin does not show the anchor yet: inscribe the anchoring entry ${pending.next} before ${target}`);
    if (!pending.queue.includes(target)) refuse("invalid-evidence", "HEAD_NOT_NEXT", `${target} is already inscribed on the anchoring sat`);
    refuse("invalid-evidence", "HEAD_NOT_NEXT", `${target} does not follow ${pending.accepted}, the head Bitcoin shows; inscribe ${pending.next} first`);
  }
  // The stored line, verbatim: the signed bytes Bitcoin will carry (P9.6).
  const content = new TextEncoder().encode(`${log.lines[index]}\n`);
  const prepared = await prepareInscriptionOnSat({
    ...rest,
    buildContent: (satoshi) => {
      if (satoshi !== log.sat.sat) {
        refuse("invalid-evidence", "WRONG_SAT", `the first funding UTXO holds sat ${satoshi}, not the anchoring sat ${log.sat.sat}`);
      }
      return Promise.resolve({ content, contentType: ORIGINALS_INSCRIPTION_TYPE });
    },
  });
  return { versionId: target, sat: log.sat.did, remaining: pending.remaining - 1, prepared };
}

export interface CatchUpParams extends ReadAnchoredOptions {
  sdk: OriginalsSDK;
  did: string;
  recoveryStore: InscriptionRecoveryStore;
  /**
   * The recovery ids (commit txids) of the pairs prepared for this Original
   * that the store still holds. Records for other entries or sats are skipped.
   */
  recoveryIds: Iterable<string>;
}

/** One step of publishing the committed entries Bitcoin does not show yet. */
export type CatchUpStep =
  /** Bitcoin shows the committed head. */
  | { action: "done"; pending: PendingEntries }
  /**
   * Prepare `versionId` (`prepareEntryInscription`) and submit it. `replaces`
   * lists confirmed inscriptions of the same entry Bitcoin ignored (P9.13):
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

/** The bytes a prepared reveal inscribes, if it inscribes one Originals entry. */
function inscribedBytes(prepared: PreparedInscriptionOnSat): Uint8Array | undefined {
  try {
    const reveal = btc.Transaction.fromRaw(hex.decode(prepared.revealTxHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    const witness = reveal.getInput(0).finalScriptWitness;
    const inscriptions = witness ? parseWitness(witness) : undefined;
    if (inscriptions?.length !== 1 || inscriptions[0].tags.contentType !== ORIGINALS_INSCRIPTION_TYPE) return undefined;
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

/**
 * Decide the next step of catching up, from a fresh read of the sat and the
 * recorded pairs. Call it again after each step: it re-reads the accepted head
 * every time, so a reorganisation re-derives the queue, and it never prepares
 * an entry while a pair for it is pending, nor one Bitcoin already accepts.
 */
export async function catchUp(params: CatchUpParams): Promise<CatchUpStep> {
  const { sdk, did, recoveryStore, recoveryIds, ...read } = params;
  const log = await storedLog(sdk, did);
  const pending = pendingFrom(did, log, await readSat(sdk, did, log, read));
  if (pending.next === null) return { action: "done", pending };
  const versionId = pending.next;
  const content = new TextEncoder().encode(`${log.lines[log.ids.indexOf(versionId)]}\n`);
  const anchoring = pending.view.report.anchoring;
  const ignored = new Set((anchoring?.ignored ?? []).map((i) => i.inscription));
  const holding = pending.view.report.ownership?.output;
  const replaces: string[] = [];
  const resumable: InscriptionRecoveryRecord[] = [];
  for (const id of recoveryIds) {
    const record = await recoveryStore.load(id);
    if (!record || record.recoveryId !== id) continue;
    const { prepared } = record;
    if (prepared.satoshi !== log.sat.sat || prepared.network !== NETWORK[log.sat.network]) continue;
    const body = inscribedBytes(prepared);
    if (!body || !sameBytes(body, content)) continue;
    if (await isConfirmed(read.provider, prepared.revealTxId)) {
      // Confirmed: Bitcoin either ignored it (a replacement is needed) or has not indexed it yet.
      if (ignored.has(prepared.inscriptionId)) {
        replaces.push(prepared.inscriptionId);
        continue;
      }
      return { action: "wait-for-confirmation", versionId, recoveryId: id, inscriptionId: prepared.inscriptionId, reason: "not-indexed", pending };
    }
    // A pair can still land only while the sat sits in its funding input or its own commit.
    const first = prepared.fundingUtxos[0];
    const live = !holding || [`${first.txid}:${first.vout}`, `${prepared.commitTxId}:0`, `${prepared.revealTxId}:0`].includes(holding);
    if (!live) continue;
    if (record.broadcast === "reveal_broadcast") {
      return { action: "wait-for-confirmation", versionId, recoveryId: id, inscriptionId: prepared.inscriptionId, reason: "unconfirmed", pending };
    }
    resumable.push(record);
  }
  const [resume] = resumable;
  if (resume) return { action: "resume", versionId, recoveryId: resume.recoveryId, broadcast: resume.broadcast, pending };
  return { action: "prepare", versionId, replaces, pending };
}

export interface ReadAnchoredOptions {
  provider: Pick<OrdinalsProvider, "getSatSnapshot" | "getTransactionStatus">;
  clock: InscriptionClock;
  /** Which index serves the sat read, reported as used (P9.11; `satEvidence`). */
  index: string;
}

/** Read the anchoring sat and verify the Original against it (P9.12, P9.13). */
export async function readAnchored(sdk: OriginalsSDK, did: string, options: ReadAnchoredOptions): Promise<OriginalView> {
  return readSat(sdk, did, await storedLog(sdk, did), options);
}

async function readSat(sdk: OriginalsSDK, did: string, { sat }: StoredLog, options: ReadAnchoredOptions): Promise<OriginalView> {
  if (!options.provider.getSatSnapshot) refuse("incomplete-evidence", "SAT_SNAPSHOT_UNSUPPORTED", "the provider cannot read a complete sat");
  const snapshot = await options.provider.getSatSnapshot(sat.sat);
  if (snapshot.network !== NETWORK[sat.network] || snapshot.sat !== sat.sat) {
    refuse("invalid-evidence", "NETWORK_MISMATCH", `the provider read sat ${snapshot.sat} on ${snapshot.network}, not ${sat.did}`);
  }
  const satpoint = snapshot.ownership.satpoint;
  const ownerConfirmations = satpoint ? (await options.provider.getTransactionStatus(satpoint.split(":")[0])).confirmations ?? 0 : 0;
  const evidence = await satEvidence(snapshot, { clock: options.clock, ownerConfirmations, index: options.index });
  return sdk.get(did, { bitcoin: [evidence] });
}
