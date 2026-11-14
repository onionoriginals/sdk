/**
 * EVM anchoring, the parts every layer shares (originals-spec PR 59, proposed:
 * P3.9, P9.19-P9.29, P14.18-P14.22). EXPERIMENTAL and PROVISIONAL throughout:
 * section 14 calls every value here proposed and provisional, and P14.21 pins
 * no anchor contract yet. Until it does, a writer MUST NOT write an `anchor`
 * member and a verifier reports one as unsupported (section 14, "EVM
 * anchoring"). This module lets an experiment supply its own pin
 * (`EvmAnchorPin`); with none, `evmSupport` says unsupported.
 *
 * Pure and browser-safe: nothing here talks to a chain. Providers' reads are
 * adapter assertions, as Bitcoin index reads are (P9.5, P9.21).
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { OriginalsError, fail } from "../errors.js";
import { isJsonObject } from "../json/index.js";

function invalid(code: string, message: string): never {
  throw new OriginalsError("invalid-evidence", code, message);
}

/** P14.18: the `anchor` member of `asset`, exactly `{chain, minter}`. */
export interface EvmAnchor {
  /** A CAIP-2 chain ID in the eip155 namespace (P14.18). */
  chain: string;
  /** `0x` and 40 lowercase hex digits; no EIP-55 checksum (P14.18). */
  minter: string;
}

/** P9.27: who can undo or block what an anchor on a chain establishes. */
export type TrustClass = "consensus" | "exit-protected" | "consortium" | "operator";

/** P9.28: anchor layers, lowest first. Bitcoin is above both, and last. */
export type AnchorLayer = "attested" | "proven" | "bitcoin";

export const LAYER_RANK: Readonly<Record<AnchorLayer, number>> = Object.freeze({ attested: 0, proven: 1, bitcoin: 2 });

/** P9.27, P9.28: the layer of a trust class. */
export function layerOfClass(cls: TrustClass): Exclude<AnchorLayer, "bitcoin"> {
  return cls === "consensus" || cls === "exit-protected" ? "proven" : "attested";
}

/** What a report says of ordering and ownership on a chain of this class (P9.27). */
export function describeClass(cls: TrustClass): "proven" | "attested-by-validators" | "attested-by-operator" {
  if (cls === "consensus" || cls === "exit-protected") return "proven";
  return cls === "consortium" ? "attested-by-validators" : "attested-by-operator";
}

/**
 * One row of P14.22. `classes` keeps every class a revision gave the chain,
 * oldest first, each with the time (ms since epoch, UTC midnight of the date)
 * from which it applies, because a move is judged by the class that applied
 * at its departure record's timestamp (P9.28, P14.22).
 */
export interface ListedChain {
  name: string;
  chain: string;
  chainId: bigint;
  /** The hash of block 0, lowercase 0x hex (P9.21). */
  genesisHash: string;
  classes: ReadonlyArray<{ from: number; class: TrustClass }>;
}

const assessed = Date.UTC(2026, 10, 11);
const row = (name: string, id: number, genesisHash: string, cls: TrustClass): ListedChain =>
  Object.freeze({ name, chain: `eip155:${id}`, chainId: BigInt(id), genesisHash, classes: Object.freeze([Object.freeze({ from: assessed, class: cls })]) });

/**
 * P14.22 as of originals-spec PR 59 ce19572 (owner decision, 14 November 2026): one chain, Base, a
 * proven chain, its row as assessed 11 November 2026. PROVISIONAL. With Base alone no move between EVM
 * chains is possible: an Original anchored on Base moves only to Bitcoin (P9.28). The chains the first
 * list named (Ethereum, Monad, Arbitrum One, Arc, Tempo, Robinhood Chain, Elysium) were removed, so an
 * `anchor` member naming one is unsupported, not invalid, and a writer refuses it (P9.19). The trust
 * classes, layers and move rules stay for a later revision; `EvmAnchorPin.chains` can list other chains
 * for an experiment, as the tests and the devnet journeys do.
 */
export const EVM_CHAINS: ReadonlyArray<ListedChain> = Object.freeze([
  row("Base", 8453, "0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd", "exit-protected"),
]);

/**
 * P14.21: the anchor contract this verifier relies on. The spec pins none yet,
 * so there is no default: an experiment supplies its own (for example a
 * contract it deployed on a local devnet), and may add chains to the list for
 * that devnet. Nothing built on a supplied pin supports an interoperability
 * claim.
 */
export interface EvmAnchorPin {
  /** The contract address, lowercase 0x hex (P14.21): the common one, and the default for every chain. */
  address: string;
  /**
   * P14.21 (PR 59 a3ffdc1): the address on a chain where the common one is
   * unavailable, keyed by `eip155:<id>`, each lowercase 0x hex. The runtime
   * code hash stays common. Use `anchorAddress` to look one up.
   */
  addresses?: Readonly<Record<string, string>>;
  /** keccak256 of the runtime code, lowercase 0x hex (P9.21). */
  codeHash: string;
  /**
   * Chains to use instead of `EVM_CHAINS`, as for a devnet. Default `EVM_CHAINS`, which is Base alone
   * (P14.22 at PR 59 ce19572). EXPERIMENTAL: a list here is the experiment's, not the spec's.
   */
  chains?: ReadonlyArray<ListedChain>;
}

/** The address P14.21 fixes for `chain`: its own where the pin lists one, else the common one (P14.18, P14.21). */
export function anchorAddress(pin: EvmAnchorPin, chain: string): string {
  const own = pin.addresses?.[chain];
  return own ?? pin.address;
}

/** The P14.21 pin of the spec revision this code follows: none (originals-spec PR 59). */
export const SPEC_EVM_PIN: EvmAnchorPin | null = null;

const CHAIN = /^eip155:[1-9][0-9]{0,19}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const TWO_64 = 1n << 64n;

/** P14.18: check an `anchor` member's form. Whether its chain is listed is `evmSupport`'s question. */
export function checkAnchor(value: unknown, where = "state.asset.anchor"): EvmAnchor {
  if (!isJsonObject(value)) invalid("STATE_ANCHOR_MEMBER", `${where} must be an object {chain, minter} (P14.18)`);
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("chain") || !keys.includes("minter")) invalid("STATE_ANCHOR_MEMBER", `${where} is exactly {chain, minter} (P14.18)`);
  const { chain, minter } = value;
  if (typeof chain !== "string" || !CHAIN.test(chain) || BigInt(chain.slice(7)) >= TWO_64) {
    invalid("STATE_ANCHOR_CHAIN", `${where}.chain must be eip155: and a canonical decimal chain ID below 2^64 (P14.18)`);
  }
  if (typeof minter !== "string" || !ADDRESS.test(minter)) invalid("STATE_ANCHOR_MINTER", `${where}.minter must be 0x and 40 lowercase hex digits (P14.18)`);
  return { chain, minter };
}

export const chainIdOf = (chain: string): bigint => BigInt(chain.slice("eip155:".length));

/** The P14.22 row for `chain`, in the pin's list, or undefined when it is not listed. */
export function listedChain(chain: string, pin: EvmAnchorPin | null = SPEC_EVM_PIN): ListedChain | undefined {
  return (pin?.chains ?? EVM_CHAINS).find((c) => c.chain === chain);
}

/** The class that applied to `chain` at `time` (ms), or its first class before any row applied (P9.28, P14.22). */
export function classAt(listed: ListedChain, time: number): TrustClass {
  let cls = listed.classes[0].class;
  for (const c of listed.classes) if (c.from <= time) cls = c.class;
  return cls;
}

/** The current class of a listed chain (P9.27: a verifier reports the class of the revision it implements). */
export const currentClass = (listed: ListedChain): TrustClass => listed.classes[listed.classes.length - 1].class;

/**
 * Whether a verifier can support an Original anchored on `chain` (P9.19,
 * P9.21, section 14): unsupported, never invalid, when no contract is pinned
 * or the chain is not listed.
 */
export function evmSupport(chain: string, pin: EvmAnchorPin | null = SPEC_EVM_PIN):
  | { supported: true; listed: ListedChain; pin: EvmAnchorPin }
  | { supported: false; reason: "no-anchor-contract-pinned" | "chain-not-listed" } {
  if (!pin) return { supported: false, reason: "no-anchor-contract-pinned" };
  const listed = listedChain(chain, pin);
  if (!listed) return { supported: false, reason: "chain-not-listed" };
  return { supported: true, listed, pin };
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

/** `keccak256(d)`, the `original` argument of `mint` (P14.19): `d` is the did:vh's UTF-8 bytes. */
export function originalHash(didVh: string): Uint8Array {
  return keccak_256(utf8ToBytes(didVh));
}

/**
 * P14.19: `uint256(keccak256(abi.encode(keccak256(d), m)))`. `abi.encode` of a
 * bytes32 and an address is the 32 bytes, then the address left-padded to 32.
 */
export function tokenIdOf(didVh: string, minter: string): bigint {
  if (!ADDRESS.test(minter)) invalid("STATE_ANCHOR_MINTER", "the minter is 0x and 40 lowercase hex digits (P14.18)");
  const encoded = new Uint8Array(64);
  encoded.set(originalHash(didVh), 0);
  encoded.set(fromHex(minter.slice(2)), 44);
  return BigInt(`0x${hex(keccak_256(encoded))}`);
}

/** A parsed did:evm token alias (P14.18). */
export interface EvmAlias {
  chain: string;
  contract: string;
  tokenId: bigint;
}

const DID_EVM = /^did:evm:([1-9][0-9]{0,19}):(0x[0-9a-f]{40}):(0|[1-9][0-9]{0,77})$/;
const TWO_256 = 1n << 256n;

/** P14.18: `did:evm:<chain ID>:<contract address>:<token ID>`. Any other form is rejected. */
export function parseEvmAlias(did: string): EvmAlias {
  const m = DID_EVM.exec(did);
  if (!m || BigInt(m[1]) >= TWO_64 || BigInt(m[3]) >= TWO_256) invalid("STATE_ALIASES", `${did} is not a did:evm DID of the form did:evm:<chain ID>:<lowercase address>:<token ID> (P14.18)`);
  return { chain: `eip155:${m[1]}`, contract: m[2], tokenId: BigInt(m[3]) };
}

export function evmAliasOf(chain: string, contract: string, tokenId: bigint): string {
  return `did:evm:${chainIdOf(chain)}:${contract}:${tokenId}`;
}

/** P14.18: the token's CAIP-19 asset ID, for wallets; never written in `aliases`. */
export function caip19Of(alias: string): string {
  const a = parseEvmAlias(alias);
  return `${a.chain}/erc721:${a.contract}/${a.tokenId}`;
}

/** The layer an Original's anchor member puts it in (P9.28): Bitcoin without one. Undefined when the chain is unlisted. */
export function layerOfAnchor(anchor: EvmAnchor | undefined, pin: EvmAnchorPin | null, time?: number): AnchorLayer | undefined {
  if (!anchor) return "bitcoin";
  const listed = listedChain(anchor.chain, pin);
  if (!listed) return undefined;
  return layerOfClass(time === undefined ? currentClass(listed) : classAt(listed, time));
}

/** Throw unsupported-profile for an anchor this verifier cannot support (P9.19, section 14). */
export function requireSupported(chain: string, pin: EvmAnchorPin | null): { listed: ListedChain; pin: EvmAnchorPin } {
  const s = evmSupport(chain, pin);
  if (!s.supported) {
    fail("unsupported-profile", s.reason === "chain-not-listed" ? "EVM_CHAIN_NOT_LISTED" : "EVM_NO_ANCHOR_CONTRACT", s.reason === "chain-not-listed" ? `${chain} is not in this verifier's revision of P14.22: unsupported, not invalid (P9.19)` : "P14.21 pins no anchor contract: an Original with an anchor member is unsupported, not invalid (section 14)");
  }
  return { listed: s.listed, pin: s.pin };
}

/**
 * One publication record (P14.20), as `publication(tokenId, index)` returns it
 * at the read block, with its bytes when the reader read them. A reader MUST
 * NOT read the bytes of a record whose lengths exceed the limit or whose
 * media type is longer than 255 bytes (P9.25): those records have no bytes.
 */
export interface EvmRecord {
  index: number;
  /** The block timestamp the record holds, seconds (P14.20). */
  timestamp: number;
  metadataLength: number;
  bodyLength: number;
  /** Its own index if it stored its body, or the earlier record whose body it refers to (P14.20). */
  bodyOf: number;
  mediaType: string;
  /** The stored metadata, read in ranges (P14.20), or absent when not read. */
  metadata?: Uint8Array;
  /** The body (the referred record's for `bodyOf !== index`), or absent when not read. */
  body?: Uint8Array;
}

/**
 * What one provider reported for one token (P9.21, P9.22): adapter
 * assertions. `chainId` and `genesisHash` are what it reported for
 * `eth_chainId` and block 0; `block` is the finalized block the read was made
 * at, which the reader chooses as the lower of its providers' finalized
 * blocks (P9.22); `codeHash` is keccak256 of the code at the pinned address
 * at that block, or null for no code; `owner` is `ownerOf` at that block, or
 * null when the token does not exist.
 */
export interface EvmProviderRead {
  provider: string;
  chainId: bigint;
  genesisHash: string;
  /** The provider's own finalized block number, before the reader chose the common one. */
  finalized: number;
  block: { number: number; hash: string };
  codeHash: string | null;
  owner: string | null;
  /**
   * Every record of the token at `block` from index `from`, in index order, or
   * null if they could not be read (P9.25).
   */
  records: EvmRecord[] | null;
  /**
   * P9.25 (MAY): the first record index read, when the reader resumed from a
   * retained checkpoint: its `record` + 1. Default 0: every record. A
   * verifier accepts a later start only with that checkpoint and a log that
   * reaches its head (`resumableCheckpoint`).
   */
  from?: number;
  /**
   * P9.22 (PR 59 1b5c484): the provider could not serve the contract's state
   * at `block`, as when finality trails the state it keeps, or its records
   * could not be read there. It is not usable: the verifier drops it, its
   * answers are not evidence, and the reads of the providers that remain
   * usable stand. Its other fields then carry no state.
   */
  stateUnavailable?: boolean;
  /** Records seen above `block` (observed, never accepted; P9.22), for pending labels. */
  observed?: EvmRecord[];
  /**
   * Optional: the hashes this provider reports for earlier block numbers the
   * verifier retained (`RetainedEvmBlock`), so a replaced finalized block below
   * `block` is found (P9.22). P9.22 assumes finality and does not require
   * these reads; without them only a retained block at `block`'s number can be
   * checked. A hash that differs is evidence of a replaced block.
   */
  blockHashes?: Array<{ number: number; hash: string }>;
}

/** Every provider's read of one token on one chain (P9.21, P9.22). Missing evidence when empty. */
export interface EvmTokenEvidence {
  /** The chain the reader read, `eip155:<id>`. */
  chain: string;
  /** The token alias it read (P14.18). */
  alias: string;
  reads: EvmProviderRead[];
}

/**
 * The finalized block a verifier accepted before, per chain, so a replaced
 * block is reported as a finality failure with `authoritative-source-changed`
 * (P9.22, VH-Log [S20]).
 */
export interface RetainedEvmBlock {
  chain: string;
  number: number;
  hash: string;
}

/**
 * P9.25 (PR 59 1b5c484, MAY; owner decision, 13 November 2026): a retained
 * verified checkpoint of one token, from which a verifier resumes and reads
 * only the records after its record index.
 *
 * The spec's minimum members: the accepted head entry's versionId
 * (`<number>-<entry hash>`, which pins every earlier entry), and the chain
 * read that verified it: the chain (CAIP-2), the token as the contract address
 * and the token ID, the index of the record that accepted the head entry, the
 * number and hash of the finalized block it was read at (P9.22), and the
 * chain's trust class at that block (P9.27). A retained result lacking any of
 * them is not a checkpoint (`isEvmCheckpoint`). A checkpoint holds no entries:
 * whoever resumes supplies the log, whose entry N must have the head's
 * versionId (`resumableCheckpoint`); otherwise the token is read from its
 * first record. None is made while a publication waits on an unverifiable
 * entry (P9.15), and one resting on a block the chain replaced is discarded
 * (P9.22).
 *
 * PROVISIONAL, beyond those members: what this verifier keeps to continue the
 * P9.13-P9.15 rules without re-reading earlier records, which the spec leaves
 * to the implementation: the anchor (or arrival), the publications accepted
 * after it and the conflicting anchors through the record index, each with the
 * timestamp its record holds, the greatest record timestamp through it
 * (P9.20), and whether the head is a move entry. They are record placements,
 * never entries.
 */
export interface EvmCheckpoint {
  /** The accepted head entry's versionId, `<number>-<entry hash>` (P9.25). */
  head: string;
  /** The chain, as its CAIP-2 ID (P9.25, [S31]). */
  chain: string;
  /** The anchor contract's address, lowercase 0x hex (P9.25, P14.21). */
  contract: string;
  /** The token ID, decimal (P9.25, P14.19). */
  tokenId: string;
  /** The index of the record that accepted the head entry (P9.25). A resumed read starts after it. */
  record: number;
  /** The finalized block the read was made at (P9.22, P9.25). */
  block: { number: number; hash: string };
  /**
   * The chain's trust class at that block (P9.25, P9.27): the class this
   * verifier's revision of P14.22 gave it when the block was read.
   * PROVISIONAL: how the history of classes is kept and resolved is open (D6).
   */
  class: TrustClass;
  /** PROVISIONAL: whether the anchor is an arrival (P9.29). */
  arrival: boolean;
  /** PROVISIONAL: the anchor or arrival, record index, versionId, record timestamp (s) and inscription time (ms; P9.20). */
  anchor: EvmCheckpointPlacement;
  /** PROVISIONAL: the publications accepted after it, through `record`, in index order. */
  accepted: EvmCheckpointPlacement[];
  /** PROVISIONAL: the conflicting anchors at or below `record` (P9.16, P9.24). */
  conflicting: EvmCheckpointPlacement[];
  /** PROVISIONAL: the greatest timestamp among the records through `record` (s), for later inscription times (P9.20). */
  latest: number;
  /** PROVISIONAL: whether the head is a move entry: nothing later is accepted on this token (P9.29). */
  departed: boolean;
}

export interface EvmCheckpointPlacement {
  index: number;
  versionId: string;
  timestamp: number;
  time: number;
}

const TRUST_CLASSES: ReadonlyArray<string> = ["consensus", "exit-protected", "consortium", "operator"];
const VERSION_ID = /^([1-9][0-9]{0,15})-\S+$/;
const HASH = /^0x[0-9a-f]{64}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const index = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const placement = (v: unknown): v is EvmCheckpointPlacement =>
  isJsonObject(v) && index(v.index) && typeof v.versionId === "string" && VERSION_ID.test(v.versionId) && typeof v.timestamp === "number" && Number.isFinite(v.timestamp) &&
  typeof v.time === "number" && Number.isFinite(v.time);

/**
 * P9.25: whether a retained value is a checkpoint: every minimum member
 * present and well formed, and this verifier's own members consistent with
 * them (the head is the last placement, at the record index). Anything else
 * is not a checkpoint and is never resumed from.
 */
export function isEvmCheckpoint(value: unknown): value is EvmCheckpoint {
  if (!isJsonObject(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.head !== "string" || !VERSION_ID.test(v.head)) return false;
  if (typeof v.chain !== "string" || !CHAIN.test(v.chain) || BigInt(v.chain.slice(7)) >= TWO_64) return false;
  if (typeof v.contract !== "string" || !ADDRESS.test(v.contract)) return false;
  if (typeof v.tokenId !== "string" || !DECIMAL.test(v.tokenId) || BigInt(v.tokenId) >= TWO_256) return false;
  if (!index(v.record)) return false;
  if (!isJsonObject(v.block) || !index(v.block.number) || typeof v.block.hash !== "string" || !HASH.test(v.block.hash)) return false;
  if (typeof v.class !== "string" || !TRUST_CLASSES.includes(v.class)) return false;
  if (typeof v.arrival !== "boolean" || typeof v.departed !== "boolean" || typeof v.latest !== "number" || !Number.isFinite(v.latest)) return false;
  if (!placement(v.anchor) || !Array.isArray(v.accepted) || !v.accepted.every(placement) || !Array.isArray(v.conflicting) || !v.conflicting.every(placement)) return false;
  const record = v.record;
  const last = v.accepted.at(-1) ?? v.anchor;
  return last.index === record && last.versionId === v.head && v.conflicting.every((c) => c.index <= record);
}

/** The did:evm alias of a checkpoint's token (P14.18). */
export function checkpointAlias(c: Pick<EvmCheckpoint, "chain" | "contract" | "tokenId">): string {
  return evmAliasOf(c.chain, c.contract, BigInt(c.tokenId));
}

/** The entry number of a versionId, `<number>-<entry hash>` (P9.25). */
export function versionNumber(versionId: string): number | undefined {
  const m = VERSION_ID.exec(versionId);
  return m ? Number(m[1]) : undefined;
}

/**
 * P9.25: the retained checkpoint of `alias` that `log` lets a verifier resume
 * from: a checkpoint (`isEvmCheckpoint`) whose head is the versionId of the
 * log's entry N, N being the head's number. A log that ends before entry N, or
 * whose entry N has another versionId, resumes from none, and the token is
 * then read from its first record. Of several, the one with the highest
 * record index.
 */
export function resumableCheckpoint(checkpoints: ReadonlyArray<unknown>, alias: string, log: ReadonlyArray<unknown>): EvmCheckpoint | undefined {
  let best: EvmCheckpoint | undefined;
  for (const c of checkpoints) {
    if (!isEvmCheckpoint(c) || checkpointAlias(c) !== alias) continue;
    const n = versionNumber(c.head)!;
    const entry = log[n - 1] as { versionId?: unknown } | null | undefined;
    if (entry?.versionId !== c.head) continue;
    if (!best || c.record > best.record) best = c;
  }
  return best;
}
