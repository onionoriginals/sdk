/**
 * The did:btco alias that names an Original's anchoring sat (plan 012 §3.1,
 * §3.5; owner decision Q15). The network prefixes `sig:`, `test:` and `reg:`
 * are this profile's, as the SDK uses them (P9.10, P14.12; owner decision, D6;
 * spec PR #50 (open)).
 */
import { OriginalsError, fail } from "../errors.js";

export type BitcoinNetwork = "mainnet" | "signet" | "testnet" | "regtest";

/** The largest sat number (did:btco method v0.2.0). */
export const MAX_SAT = 2_099_999_997_689_999n;

const PREFIX: Record<string, BitcoinNetwork> = { "": "mainnet", "sig:": "signet", "test:": "testnet", "reg:": "regtest" };

export interface BtcoAlias {
  did: string;
  network: BitcoinNetwork;
  /** Canonical decimal sat number. */
  sat: string;
}

/**
 * Parse `did:btco[:sig|:test|:reg]:<sat>`, or throw STATE_ALIASES (P9.10, P14.12).
 * The did:btco method v0.2.0 does not yet define network prefixes; this grammar
 * is proposed upstream as decentralized-identity/labs-ordinals-plus#4 [S30].
 */
export function parseBtcoAlias(did: string): BtcoAlias {
  const m = /^did:btco:((?:sig|test|reg):)?(0|[1-9]\d{0,15})$/.exec(did);
  if (!m || BigInt(m[2]) > MAX_SAT) fail("invalid-evidence", "STATE_ALIASES", `${did} is not a did:btco naming a sat`);
  return { did, network: PREFIX[m[1] ?? ""], sat: m[2] };
}

export function btcoAliasOf(aliases: readonly string[]): string | undefined {
  return aliases.find((a) => a.startsWith("did:btco:"));
}

/**
 * One inscription, as one index reports it. The same shape serves any sat:
 * an Original's anchoring sat, or a did:btco signer DID's sat (P5.13).
 */
export interface SatInscription {
  id: string;
  /** The sat number, in decimal, that the index reports the inscription on (P9.10). */
  sat: string;
  /** The network the index read it from (P9.10). */
  network: BitcoinNetwork;
  height: number;
  transactionIndex: number;
  inscriptionIndex: number;
  /** 0 while unconfirmed. */
  confirmations: number;
  /** The greatest block timestamp of its block and the block's ancestors, epoch ms (P9.15). */
  inscriptionTime: number;
  mediaType: string;
  content: Uint8Array;
  /**
   * The inscription's raw metadata, or null or absent when it carries none.
   * Originals inscriptions carry none (P9.17); a did:btco DID document is
   * carried here as CBOR (P5.13). For a `delegated` or `content-encoding`
   * inscription, null means it carries none and absent means the reader did
   * not read it.
   */
  metadata?: Uint8Array | null;
  /**
   * Set when the reader observed the inscription but did not establish its
   * own body; `content` is then empty. PROVISIONAL.
   * - `delegated`, `content-encoding`: its body is another inscription's, or
   *   encoded, and P9.14 defines no encoding. It is never an Originals entry
   *   (an Originals media type is rejected, `unsupported-encoding`; P9.14,
   *   P9.17). Its own metadata, which delegation and body encoding do not
   *   affect, is read as for any inscription: on a did:btco DID's sat it is a
   *   version candidate, and metadata not read (absent) stops the history
   *   (P5.13; whether such an inscription counts as a version is an open
   *   question, PROVISIONAL).
   * - `not-read`: its body and metadata were past the reader's byte budget,
   *   or not asked for. An unread Originals inscription is missing evidence:
   *   the verification fails (`SAT_READ_INCOMPLETE`, P9.17), unless
   *   `contentLength` or `metadataPresent` already rejects it. An unread
   *   inscription on a did:btco DID's sat could be a version: the history
   *   stops before it (missing evidence, P5.13).
   * Inscriptions of other media types are not Originals inscriptions either way.
   */
  unsupported?: "delegated" | "content-encoding" | "not-read";
  /** For a `not-read` inscription, the body length the index reports. PROVISIONAL. */
  contentLength?: number;
  /** For a `not-read` inscription: it carries metadata, which the reader did not read. PROVISIONAL. */
  metadataPresent?: boolean;
}

/** What one index reported for one sat at one tip. */
export interface SatEvidence {
  /**
   * The did:btco alias whose sat this read was asked about. A label only:
   * each inscription counts for it by the sat and network the index reports
   * (P9.10).
   */
  sat: string;
  /** Which index served the read (P9.11). Reads of one sat by different indexes are compared. */
  index: string;
  tip: { height: number; hash: string };
  inscriptions: SatInscription[];
  /** The output holding the sat now, or null when the adapter observed none. */
  owner: { output: string; address?: string; confirmations: number } | null;
}

/** A position in chain order: block height, transaction index, inscription index (P5.13). */
export interface ChainPosition {
  height: number;
  transactionIndex: number;
  inscriptionIndex: number;
}

export function chainOrder(a: ChainPosition, b: ChainPosition): number {
  return a.height - b.height || a.transactionIndex - b.transactionIndex || a.inscriptionIndex - b.inscriptionIndex;
}

/** Why an inscription did not count for the sat it was read under. */
export type PlacementReason = "not-on-sat" | "other-network" | "placement-disputed" | "after-disputed-placement";

/** The inscriptions every index used places on one sat, merged (P9.10, P9.11). */
export interface SatRead {
  alias: BtcoAlias;
  /** The indexes whose reads were compared, in the order first supplied. */
  indexes: string[];
  /** The lowest tip among the reads. */
  tip: { height: number; hash: string };
  /**
   * Inscriptions every index places on the sat, in chain order, before the
   * first disputed one. Confirmations are the lowest any index reports.
   */
  inscriptions: SatInscription[];
  /** Inscriptions supplied under this alias that do not count for it. */
  excluded: Array<{ inscription: string; reason: PlacementReason }>;
  /** Inscriptions whose placement the indexes disagree on: missing evidence until they agree. */
  disputed: string[];
  /** The sat's holder when every index agrees on it; null when none was observed or they disagree. */
  owner: SatEvidence["owner"];
  ownerDisputed: boolean;
}

const sameBytes = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) =>
  (a ?? null) === null ? (b ?? null) === null : !!b && a!.length === b.length && a!.every((x, k) => x === b[k]);

function sameReport(a: SatInscription, b: SatInscription): boolean {
  return a.height === b.height && a.transactionIndex === b.transactionIndex && a.inscriptionIndex === b.inscriptionIndex &&
    a.inscriptionTime === b.inscriptionTime && a.mediaType === b.mediaType && sameBytes(a.content, b.content) && sameBytes(a.metadata, b.metadata) &&
    (a.unsupported ?? null) === (b.unsupported ?? null) && (a.contentLength ?? null) === (b.contentLength ?? null) &&
    (a.metadataPresent ?? false) === (b.metadataPresent ?? false);
}

export interface ReadSatOptions {
  /**
   * Whether a disputed inscription, as each index reports it, could count for
   * the reader. One that could leaves everything after it on the sat
   * undecided (P9.10); one that could not (for an Original, an inscription no
   * index reports as an Originals inscription) is excluded as
   * `placement-disputed` without holding back later ones, and is not listed
   * in `disputed`. Default: every disputed inscription could count.
   */
  couldCount?: (reports: SatInscription[]) => boolean;
}

/**
 * Merge the reads of one sat by the indexes the verifier uses (P9.10). An
 * inscription counts only when every read reports it on the alias's sat
 * number and network, consistently; when they disagree, it and, if it could
 * count (`couldCount`), everything after it in chain order on this sat are
 * undecided. Unconfirmed inscriptions are never disputed: they are only
 * observed (P9.5).
 */
export function readSat(alias: string, reads: SatEvidence[], options: ReadSatOptions = {}): SatRead {
  const parsed = parseBtcoAlias(alias);
  if (reads.length === 0) throw new OriginalsError("incomplete-evidence", "SAT_READ_MISSING", `no read of ${alias}`);
  const on = (i: SatInscription) => i.sat === parsed.sat && i.network === parsed.network;
  const ids = new Map<string, SatInscription[]>();
  for (const r of reads) for (const i of r.inscriptions) ids.set(i.id, [...(ids.get(i.id) ?? []), i]);

  const placed: SatInscription[] = [];
  const excluded: SatRead["excluded"] = [];
  const disputes: SatInscription[] = [];
  for (const [id, reports] of ids) {
    const placing = reports.filter(on);
    const everyIndex = placing.length === reads.length && reads.every((r) => r.inscriptions.some((i) => i.id === id && on(i)));
    if (everyIndex && placing.every((p) => sameReport(p, placing[0]))) {
      placed.push({ ...placing[0], confirmations: Math.min(...placing.map((p) => p.confirmations)) });
    } else if (placing.length === 0) {
      excluded.push({ inscription: id, reason: reports.some((i) => i.network !== parsed.network) ? "other-network" : "not-on-sat" });
    } else if (placing.every((p) => p.confirmations < 1)) {
      placed.push({ ...placing[0], confirmations: 0 }); // observed only
    } else if (!options.couldCount || options.couldCount(reports)) {
      disputes.push(placing[0]);
    } else {
      excluded.push({ inscription: id, reason: "placement-disputed" });
    }
  }
  placed.sort(chainOrder);
  disputes.sort(chainOrder);
  const cut = disputes[0];
  const inscriptions = cut ? placed.filter((i) => chainOrder(i, cut) < 0) : placed;
  if (cut) {
    for (const d of disputes) excluded.push({ inscription: d.id, reason: "placement-disputed" });
    for (const i of placed) if (chainOrder(i, cut) >= 0) excluded.push({ inscription: i.id, reason: "after-disputed-placement" });
  }

  const owners = reads.map((r) => r.owner);
  const ownerDisputed = owners.some((o) => (o?.output ?? null) !== (owners[0]?.output ?? null) || (o?.address ?? null) !== (owners[0]?.address ?? null));
  const owner = !ownerDisputed && owners[0] ? { ...owners[0], confirmations: Math.min(...owners.map((o) => o!.confirmations)) } : null;
  const tip = reads.map((r) => r.tip).reduce((low, t) => (t.height < low.height ? t : low));
  return { alias: parsed, indexes: [...new Set(reads.map((r) => r.index))], tip, inscriptions, excluded, disputed: disputes.map((d) => d.id), owner, ownerDisputed };
}
