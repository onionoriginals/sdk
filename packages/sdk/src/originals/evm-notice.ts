/**
 * What the SDK tells the author before EVM anchoring choices (originals-spec
 * PR 59, P9.27, P9.29), as data the caller shows and the author acknowledges,
 * like the P9.18 inscription notice (`inscriptionNotice`). EXPERIMENTAL; the
 * wording is PROVISIONAL.
 *
 * - `evmGenesisNotice`: before writing a genesis entry with an `anchor`
 *   member (P9.27).
 * - `evmMoveNotice`: before writing a move entry (P9.29). It refuses a move
 *   that is not upward (P9.28), and one whose arrival would exceed 350,000
 *   bytes (P9.29: the SDK MUST refuse it).
 * - `evmPublicationNotice`: before any publication on a token (P9.18 read
 *   through P9.20).
 */
import { OriginalsError } from "@originals/vh";
import {
  LAYER_RANK,
  ORIGINALS_INSCRIPTION_MAX_BYTES,
  checkAnchor,
  currentClass,
  layerOfClass,
  requireSupported,
  type AnchorLayer,
  type EvmAnchor,
  type EvmAnchorPin,
  type ListedChain,
  type ResourceDescriptor,
  type TrustClass,
} from "@originals/vh/originals";
import { parseJson } from "@originals/vh/json";
import { inscriptionMetadata, isActiveContent } from "./inscription.js";

/** The versionId of a stored log line. */
export function versionIdOfLine(line: string): string {
  const id = (parseJson(line) as { versionId?: unknown } | null)?.versionId;
  if (typeof id !== "string") throw new OriginalsError("invalid-evidence", "INPUT_INVALID", "a log line has a versionId");
  return id;
}

const LAYER_NAME: Record<AnchorLayer, string> = { attested: "an attested chain", proven: "a proven chain", bitcoin: "Bitcoin" };

/** P9.27's table: who can undo or block what an anchor establishes, and how a report describes it. */
const CLASS_MEANING: Record<TrustClass, string> = {
  consensus:
    "Its validator or miner set is open to anyone, and no party holds a key that can change its rules or state: a change takes effect only when its validators adopt it. Ordering and ownership are reported as proven on that chain.",
  "exit-protected":
    "It is a rollup that publishes its transaction data to a consensus chain; a transaction can be forced in without its operator, and its operator alone cannot upgrade it. Its operator can still delay publications. Ordering and ownership are reported as proven on that chain.",
  consortium:
    "A named party or group decides who joins its validator set, and its validators acting together can reorder, censor or rewrite it. Ordering and ownership are reported as attested by its validators, never as proven.",
  operator:
    "One party, or parties it controls, can upgrade it without delay, or filter or reorder its transactions, or it does not publish its transaction data to a consensus chain. Ordering and ownership are reported as attested by its operator, never as proven.",
};

/** The layers above `layer` (P9.28). */
export function layersAbove(layer: AnchorLayer): AnchorLayer[] {
  return (["attested", "proven", "bitcoin"] as AnchorLayer[]).filter((l) => LAYER_RANK[l] > LAYER_RANK[layer]);
}

export interface EvmChainSummary {
  chain: string;
  name: string;
  trustClass: TrustClass;
  layer: "attested" | "proven";
}

function summary(listed: ListedChain): EvmChainSummary {
  const trustClass = currentClass(listed);
  return { chain: listed.chain, name: listed.name, trustClass, layer: layerOfClass(trustClass) };
}

function aboveText(layer: AnchorLayer): string {
  const above = layersAbove(layer);
  return above.length === 0 ? "none" : above.map((l) => LAYER_NAME[l]).join(", then ");
}

/** P9.27: what the author is told before a genesis entry with an `anchor` member is written. */
export interface EvmGenesisNotice {
  kind: "evm-genesis";
  chain: EvmChainSummary;
  minter: string;
  /** Layers the Original can later move up to (P9.28). */
  layersAbove: AnchorLayer[];
  permanent: true;
  /** The six statements P9.27 requires, in its order (PR 59 a3ffdc1 added `publicationCost`). */
  points: [permanentAndLayer: string, staysDependent: string, trustClass: string, chainLifetime: string, publicationCost: string, minter: string];
  /** The plain statement to show the author. */
  text: string;
}

export function evmGenesisNotice(anchor: EvmAnchor, pin: EvmAnchorPin): EvmGenesisNotice {
  const a = checkAnchor(anchor, "anchor");
  const chain = summary(requireSupported(a.chain, pin).listed);
  const points: EvmGenesisNotice["points"] = [
    `Anchoring on ${chain.name} (${chain.chain}) is permanent. It is ${LAYER_NAME[chain.layer]}; the Original can later move only upward (${aboveText(chain.layer)}), never sideways, down or back.`,
    "A move does not free the Original from a chain: it stays dependent on every chain it was ever anchored on.",
    `${chain.name} is of trust class ${chain.trustClass}. ${CLASS_MEANING[chain.trustClass]} Once the Original is anchored, its ordering, its owner and whether changes can be published rest on that chain, and on whoever its class says can upgrade, pause, censor or reorder it.`,
    `Its publications last only as long as ${chain.name}'s nodes keep its state; nothing can be done for an Original whose chain stops.`,
    `A large publication can need several staged transactions (begin, append, commit), because ${chain.name} caps what one transaction can store. Every entry carries the Original's full asset state, so large metadata makes each later edit, even a rename, cost more to publish.`,
    `The minter ${a.minter} is fixed now. Only that address can mint the Original's token on ${chain.name}: if its key is lost before minting, the Original can never be anchored there; if it is stolen first, the thief can mint and hold the token.`,
  ];
  return { kind: "evm-genesis", chain, minter: a.minter, layersAbove: layersAbove(chain.layer), permanent: true, points, text: points.join(" ") };
}

/** P9.18 read through P9.20: what becomes public and permanent with a publication on a token. */
export interface EvmPublicationNotice {
  kind: "evm-publication";
  chain: EvmChainSummary;
  version: { digest: string; mediaType: string; size: number };
  entries: string[];
  permanent: true;
  activeContent: boolean;
  text: string;
}

/** `entries` are the versionIds the publication carries, in order. */
export function evmPublicationNotice(chain: string, pin: EvmAnchorPin, entries: readonly string[], d: ResourceDescriptor): EvmPublicationNotice {
  const c = summary(requireSupported(chain, pin).listed);
  const activeContent = isActiveContent(d.mediaType);
  const carried = entries.length === 1 ? `the entry ${entries[0]}` : `the log from ${entries[0]} through ${entries[entries.length - 1]}`;
  const text =
    `This publication puts the resource version ${d.digest} (${d.mediaType}, ${d.size} bytes) and ${carried}, ` +
    `with the Original's name and metadata, in the anchor contract's state on ${c.name} (${c.chain}). They become public, ` +
    `last as long as ${c.name}'s nodes keep its state, and no later entry can remove them.` +
    (activeContent ? ` ${d.mediaType} is active content: explorers may render it outside the Originals isolation rules.` : "");
  return { kind: "evm-publication", chain: c, version: { digest: d.digest, mediaType: d.mediaType, size: d.size }, entries: [...entries], permanent: true, activeContent, text };
}

/** The bytes an arrival stores: the CBOR metadata of the whole log and the body (P9.29, P14.12, P14.20). */
export function arrivalBytes(lines: readonly string[], bodySize: number): number {
  return inscriptionMetadata(lines).length + bodySize;
}

export interface EvmMoveInput {
  /** The anchor member the Original leaves (the previous entry's). */
  from: EvmAnchor;
  /** The destination's anchor member, or null for a move to Bitcoin (P9.28). */
  to: EvmAnchor | null;
  /** The stored lines the arrival carries: genesis through the move entry, in order (P9.29). */
  lines: readonly string[];
  /** The current resource version, which the arrival's body carries (P9.17). */
  version: ResourceDescriptor;
  pin: EvmAnchorPin;
}

/** P9.29: what the author is told before a move entry is written. */
export interface EvmMoveNotice {
  kind: "evm-move";
  from: EvmChainSummary;
  to: EvmChainSummary | { layer: "bitcoin"; name: "Bitcoin" };
  /** Layers that remain above the destination (P9.29). */
  layersAbove: AnchorLayer[];
  irreversible: true;
  /** The bytes the arrival stores, at most 350,000 (P9.29). */
  arrivalBytes: number;
  points: [irreversible: string, staysDependent: string, publicAndPermanent: string];
  text: string;
}

/**
 * P9.29: refuses a move that is not upward (P9.28) or whose arrival would
 * exceed 350,000 bytes, and otherwise says what the author must be told.
 */
export function evmMoveNotice(input: EvmMoveInput): EvmMoveNotice {
  const from = summary(requireSupported(checkAnchor(input.from, "from").chain, input.pin).listed);
  const to = input.to === null ? ({ layer: "bitcoin", name: "Bitcoin" } as const) : summary(requireSupported(checkAnchor(input.to, "to").chain, input.pin).listed);
  if (LAYER_RANK[to.layer] <= LAYER_RANK[from.layer]) {
    throw new OriginalsError("invalid-evidence", "MOVE_NOT_UPWARD", `a move from ${from.name} (${LAYER_NAME[from.layer]}) to ${to.name} (${LAYER_NAME[to.layer]}) is not upward: an Original moves only to a higher layer (P9.28)`);
  }
  if (input.lines.length === 0) throw new OriginalsError("invalid-evidence", "INPUT_INVALID", "the arrival carries the whole log, genesis through the move entry (P9.29)");
  const size = arrivalBytes(input.lines, input.version.size);
  if (size > ORIGINALS_INSCRIPTION_MAX_BYTES) {
    throw new OriginalsError("limit-exceeded", "MOVE_ARRIVAL_TOO_LARGE", `the arrival would store ${size} bytes, the whole log and the current version; a publication holds at most ${ORIGINALS_INSCRIPTION_MAX_BYTES} (P9.29, P9.25)`, { size, limit: ORIGINALS_INSCRIPTION_MAX_BYTES });
  }
  const first = versionIdOfLine(input.lines[0]);
  const last = versionIdOfLine(input.lines[input.lines.length - 1]);
  const where = to.layer === "bitcoin" ? "on Bitcoin, in an inscription on the destination sat" : `in the anchor contract's state on ${to.name} (${(to).chain})`;
  const points: EvmMoveNotice["points"] = [
    `The move from ${from.name} to ${to.name} cannot be reversed. Above ${to.name}, the layers that remain are: ${aboveText(to.layer)}.`,
    `The Original stays dependent on ${from.name}: a verifier still reads it to confirm the move, and while it cannot, the move is unconfirmed and the Original has no owner.`,
    `The arrival puts the whole log, from ${first} through ${last}, with the Original's name and metadata, and the resource version ${input.version.digest} (${input.version.mediaType}, ${input.version.size} bytes), ${where}. They become public and permanent, and no later entry can remove them.`,
  ];
  return { kind: "evm-move", from, to, layersAbove: layersAbove(to.layer), irreversible: true, arrivalBytes: size, points, text: points.join(" ") };
}
