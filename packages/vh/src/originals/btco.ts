/**
 * The did:btco alias that names an Original's anchoring sat (plan 012 §3.1,
 * §3.5; owner decision Q15). The network prefixes `sig:`, `test:` and `reg:`
 * are this profile's, as the SDK uses them (P9.10, P14.12; owner decision, D6;
 * spec PR #50 (open)).
 */
import { fail } from "../errors.js";

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
   * carried here as CBOR (P5.13).
   */
  metadata?: Uint8Array | null;
  /**
   * Set when the reader observed the inscription but did not establish its
   * own body; `content` is then empty and `metadata` absent. PROVISIONAL.
   * - `delegated`, `content-encoding`: its body is another inscription's, or
   *   encoded, and P9.14 defines no encoding. It is never an Originals entry
   *   (an Originals media type is rejected, `unsupported-encoding`; P9.14,
   *   P9.17) and never a did:btco version (P5.13).
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
