/**
 * Anchored Originals: assembling the log from the anchoring sat (plan 012
 * §3.4; P9.10, P9.12-P9.16; VH-Log PR 2, authoritative source).
 *
 * The caller supplies, for each sat it knows of, the inscriptions an adapter
 * read from it with their chain position, confirmation depth and inscription
 * time. Those are adapter assertions (P9.5); nothing here talks to Bitcoin.
 *
 * - Every inscription carries one complete entry as
 *   `application/vnd.originals.vh+jsonl` (owner decision Q15).
 * - The history before the anchor comes from a copy of the log, and the
 *   anchoring entry must extend it (decision A).
 * - The anchor is the first valid anchoring entry, in chain order, inscribed
 *   on the sat it names. Any other is a conflicting anchor (P9.16).
 * - After the anchor, an inscription is accepted when it extends the head, at
 *   a strictly greater height (P9.13), and passes the author checks at its
 *   inscription time (P9.15). Everything else is ignored and reported.
 * - An inscription counts from 1 confirmation, with its depth reported
 *   (decision D).
 */
import { OriginalsError } from "../errors.js";
import { parseLog, type LogEntry, type LogVerification } from "../log/index.js";
import { authorKey, stillAuthorized, versionNumberOf, type AuthorHistory, type AuthorVersion } from "./author.js";
import { btcoAliasOf, parseBtcoAlias } from "./btco.js";
import type { EntryState } from "./state.js";

/** PROVISIONAL (D6; plan 012 §3.2): the media type of an Originals inscription. */
export const ORIGINALS_INSCRIPTION_TYPE = "application/vnd.originals.vh+jsonl";

/** One inscription on a sat, as the adapter reports it. */
export interface SatInscription {
  id: string;
  height: number;
  transactionIndex: number;
  inscriptionIndex: number;
  /** 0 while unconfirmed. */
  confirmations: number;
  /** The greatest block timestamp of its block and the block's ancestors, epoch ms (P9.15). */
  inscriptionTime: number;
  mediaType: string;
  content: Uint8Array;
}

/** What an adapter read from one sat at one tip. */
export interface SatEvidence {
  /** The sat, as its did:btco alias. */
  sat: string;
  tip: { height: number; hash: string };
  inscriptions: SatInscription[];
  /** The output holding the sat now, or null when the adapter observed none. */
  owner: { output: string; address?: string; confirmations: number } | null;
  /** How many independent indexes agreed on the sat's location (P9.11). */
  indexes: number;
}

export type IgnoredReason =
  | "unconfirmed"
  | "not-an-originals-inscription"
  | "undecodable"
  | "names-another-sat"
  | "not-an-anchoring-entry"
  | "does-not-extend-copy"
  | "does-not-extend-head"
  | "not-above-previous-height"
  | "invalid-entry"
  | "author-version-unavailable"
  | "author-key-not-valid-at-inscription-time"
  | "author-deactivated-at-inscription-time";

interface Placed {
  sat: string;
  inscription: string;
  versionId: string;
  height: number;
  confirmations: number;
  inscriptionTime: number;
}

export interface AnchoringReport {
  /** The anchoring sat: the anchor's, or the one the copy names. */
  sat: string;
  /**
   * anchored: an anchor was found on Bitcoin. unverified: the log names a sat
   * but no Bitcoin evidence was supplied. not-anchored: evidence was supplied
   * and holds no valid anchor.
   */
  status: "anchored" | "unverified" | "not-anchored";
  anchor: Placed | null;
  /** Valid anchoring entries other than the anchor; never current (P9.16). */
  conflicting: Placed[];
  /** Inscriptions accepted after the anchor, in chain order. */
  accepted: Placed[];
  ignored: Array<{ sat: string; inscription: string; versionId?: string; reason: IgnoredReason }>;
  /** Entries in the supplied copy after the anchor that Bitcoin does not include. */
  superseded: number;
  /** No index lists every sat (P9.16). */
  uniqueness: "not-established";
  tip: { height: number; hash: string } | null;
}

export interface OwnershipReport {
  /** Ownership is never established, only reported (P9.11, P9.16). */
  status: "provisional";
  sat: string;
  output: string;
  address?: string;
  confirmations: number;
  indexes: number;
}

export function chainOrder(a: SatInscription, b: SatInscription): number {
  return a.height - b.height || a.transactionIndex - b.transactionIndex || a.inscriptionIndex - b.inscriptionIndex;
}

function stateOf(entry: unknown): Partial<EntryState> {
  const state = (entry as { state?: Partial<EntryState> } | null)?.state;
  return state ?? {};
}

function satNamedBy(entry: unknown): string | undefined {
  const aliases = stateOf(entry).asset?.aliases;
  return Array.isArray(aliases) ? btcoAliasOf(aliases) : undefined;
}

/** The index of the copy's anchoring entry: the first that lists a did:btco alias. */
export function anchoringIndex(entries: unknown[]): number {
  return entries.findIndex((e) => satNamedBy(e) !== undefined);
}

function decodeOne(content: Uint8Array): LogEntry | undefined {
  try {
    const entries = parseLog(new TextDecoder("utf-8", { fatal: true }).decode(content));
    return entries.length === 1 ? (entries[0] as unknown as LogEntry) : undefined;
  } catch (error) {
    if (error instanceof OriginalsError || error instanceof TypeError) return undefined;
    throw error;
  }
}

/**
 * P9.15: the author DID state at an inscription is the later of the version
 * the entry names and the latest version whose versionTime is no later than
 * the inscription time. The key must hold in that state, which must not be
 * deactivated.
 */
export function checkAtInscriptionTime(entry: LogEntry, inscriptionTime: number, histories: AuthorHistory[]): IgnoredReason | null {
  const ref = stateOf(entry).author;
  const history = ref ? histories.find((h) => h.did === ref.did) : undefined;
  if (!ref || !history) return "author-version-unavailable";
  const named = history.versions.find((v) => v.versionId === ref.versionId);
  if (!named) return "author-version-unavailable";
  let before: AuthorVersion | undefined;
  for (const v of history.versions) if (v.time <= inscriptionTime) before = v;
  const state = before && before.versionNumber > named.versionNumber ? before : named;
  if (state.deactivated) return "author-deactivated-at-inscription-time";
  let key: string;
  try {
    key = authorKey(named, ref);
  } catch (error) {
    if (error instanceof OriginalsError) return "author-key-not-valid-at-inscription-time";
    throw error;
  }
  return stillAuthorized(state, ref, key) ? null : "author-key-not-valid-at-inscription-time";
}

export interface Assembly {
  /** The log to verify: the copy's prefix, the anchor and the accepted inscriptions. */
  entries: unknown[];
  report: AnchoringReport;
  owner: OwnershipReport | null;
  /** Ignored versionIds whose rejection came from the author checks, for retroactive-revocation reporting. */
  rejectedByAuthorState: Set<string>;
}

type Verify = (entries: unknown[]) => Promise<LogVerification>;

const passes = (v: LogVerification, length: number) => !v.failure && v.entries.length === length;

/** Assemble an anchored Original's log from Bitcoin (plan 012 §3.4). */
export async function assembleFromBitcoin(copy: unknown[], evidence: SatEvidence[], verify: Verify, histories: AuthorHistory[]): Promise<Assembly> {
  const copyAnchor = anchoringIndex(copy);
  const prefix = copyAnchor >= 0 ? copy.slice(0, copyAnchor) : copy;
  const ignored: AnchoringReport["ignored"] = [];
  const rejectedByAuthorState = new Set<string>();
  const ignore = (sat: string, i: SatInscription, reason: IgnoredReason, entry?: LogEntry) => {
    ignored.push({ sat, inscription: i.id, ...(entry ? { versionId: entry.versionId } : {}), reason });
    if (entry && (reason === "author-key-not-valid-at-inscription-time" || reason === "author-deactivated-at-inscription-time")) rejectedByAuthorState.add(entry.versionId);
  };
  const usable = (sat: string, i: SatInscription): LogEntry | undefined => {
    if (i.confirmations < 1) return void ignore(sat, i, "unconfirmed");
    if (i.mediaType !== ORIGINALS_INSCRIPTION_TYPE) return void ignore(sat, i, "not-an-originals-inscription");
    const entry = decodeOne(i.content);
    if (!entry) return void ignore(sat, i, "undecodable");
    return entry;
  };

  // The first valid anchoring entry on each sat that names it and extends the copy.
  interface Candidate { evidence: SatEvidence; inscription: SatInscription; entries: unknown[]; rest: SatInscription[] }
  const candidates: Candidate[] = [];
  for (const e of evidence) {
    const sat = parseBtcoAlias(e.sat).did;
    const ordered = [...e.inscriptions].sort(chainOrder);
    for (let k = 0; k < ordered.length; k++) {
      const i = ordered[k];
      const entry = usable(sat, i);
      if (!entry) continue;
      const named = satNamedBy(entry);
      if (named === undefined) {
        ignore(sat, i, "not-an-anchoring-entry", entry);
        continue;
      }
      if (named !== sat) {
        ignore(sat, i, "names-another-sat", entry);
        continue;
      }
      const n = versionNumberOf(entry.versionId);
      if (!Number.isInteger(n) || n < 2 || n - 1 > prefix.length) {
        ignore(sat, i, "does-not-extend-copy", entry);
        continue;
      }
      const base = [...prefix.slice(0, n - 1), entry];
      const v = await verify(base);
      if (!passes(v, base.length)) {
        ignore(sat, i, v.failure?.error.code === "ENTRY_HASH_MISMATCH" ? "does-not-extend-copy" : "invalid-entry", entry);
        continue;
      }
      const author = checkAtInscriptionTime(entry, i.inscriptionTime, histories);
      if (author) {
        ignore(sat, i, author, entry);
        continue;
      }
      candidates.push({ evidence: e, inscription: i, entries: base, rest: ordered.slice(k + 1) });
      break;
    }
  }

  const named = copyAnchor >= 0 ? satNamedBy(copy[copyAnchor])! : undefined;
  const place = (sat: string, i: SatInscription, entry: unknown): Placed => ({
    sat, inscription: i.id, versionId: (entry as LogEntry).versionId, height: i.height, confirmations: i.confirmations, inscriptionTime: i.inscriptionTime,
  });
  if (candidates.length === 0) {
    const status = evidence.length === 0 ? "unverified" : "not-anchored";
    return {
      entries: status === "unverified" ? copy : prefix,
      report: { sat: named ?? evidence[0]?.sat ?? "", status, anchor: null, conflicting: [], accepted: [], ignored, superseded: 0, uniqueness: "not-established", tip: evidence[0]?.tip ?? null },
      owner: null,
      rejectedByAuthorState,
    };
  }

  candidates.sort((a, b) => chainOrder(a.inscription, b.inscription));
  const [chosen, ...others] = candidates;
  const sat = parseBtcoAlias(chosen.evidence.sat).did;
  const anchorEntry = chosen.entries[chosen.entries.length - 1];
  const anchor = place(sat, chosen.inscription, anchorEntry);
  const conflicting = others.map((c) => place(parseBtcoAlias(c.evidence.sat).did, c.inscription, c.entries[c.entries.length - 1]));

  const head = [...chosen.entries];
  const accepted: Placed[] = [];
  let lastHeight = chosen.inscription.height;
  for (const i of chosen.rest) {
    const entry = usable(sat, i);
    if (!entry) continue;
    if (i.height <= lastHeight) {
      ignore(sat, i, "not-above-previous-height", entry);
      continue;
    }
    const n = versionNumberOf(entry.versionId);
    if (n !== head.length + 1) {
      ignore(sat, i, "does-not-extend-head", entry);
      continue;
    }
    const candidate = [...head, entry];
    const v = await verify(candidate);
    if (!passes(v, candidate.length)) {
      ignore(sat, i, v.failure?.error.code === "ENTRY_HASH_MISMATCH" ? "does-not-extend-head" : "invalid-entry", entry);
      continue;
    }
    const author = checkAtInscriptionTime(entry, i.inscriptionTime, histories);
    if (author) {
      ignore(sat, i, author, entry);
      continue;
    }
    head.push(entry);
    accepted.push(place(sat, i, entry));
    lastHeight = i.height;
  }

  const included = new Set(head.map((e) => (e as LogEntry).versionId));
  const superseded = copyAnchor >= 0 ? copy.slice(copyAnchor).filter((e) => !included.has((e as LogEntry).versionId)).length : 0;
  const owner = chosen.evidence.owner;
  return {
    entries: head,
    report: { sat, status: "anchored", anchor, conflicting, accepted, ignored, superseded, uniqueness: "not-established", tip: chosen.evidence.tip },
    owner: owner ? { status: "provisional", sat, output: owner.output, ...(owner.address ? { address: owner.address } : {}), confirmations: owner.confirmations, indexes: chosen.evidence.indexes } : null,
    rejectedByAuthorState,
  };
}
