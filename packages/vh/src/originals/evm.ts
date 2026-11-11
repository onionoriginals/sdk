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

/** P14.22 as of originals-spec PR 59 (3ed0f89), assessed 11 November 2026. PROVISIONAL. */
export const EVM_CHAINS: ReadonlyArray<ListedChain> = Object.freeze([
  row("Ethereum", 1, "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3", "consensus"),
  row("Monad", 143, "0x0c47353304f22b1c15706367d739b850cda80b5c87bbc335014fef3d88deaac9", "consensus"),
  row("Base", 8453, "0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd", "exit-protected"),
  row("Arbitrum One", 42161, "0x7ee576b35482195fc49205cec9af72ce14f003b9ae69f6ba0faef4514be8b442", "exit-protected"),
  row("Arc", 5042, "0x09944e07412986bb417fd0006c89ffb71ee523d68ce2017ec2dabc944c42edad", "consortium"),
  row("Tempo", 4217, "0x49d7ec7085e77bf5a403d0fcb4cfc42a4084a89dfff60477579c5e09c9e03c54", "consortium"),
  row("Robinhood Chain", 4663, "0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c", "operator"),
  row("Elysium", 99901, "0x14cd46a8e7cfd201c7a79d307c320213f984e7a2b3297cd4e2c4b514538db600", "operator"),
]);

/**
 * P14.21: the anchor contract this verifier relies on. The spec pins none yet,
 * so there is no default: an experiment supplies its own (for example a
 * contract it deployed on a local devnet), and may add chains to the list for
 * that devnet. Nothing built on a supplied pin supports an interoperability
 * claim.
 */
export interface EvmAnchorPin {
  /** The contract address, lowercase 0x hex (P14.21). */
  address: string;
  /** keccak256 of the runtime code, lowercase 0x hex (P9.21). */
  codeHash: string;
  /** Chains to use instead of `EVM_CHAINS`, as for a devnet. Default `EVM_CHAINS`. */
  chains?: ReadonlyArray<ListedChain>;
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
  /** Every record of the token at `block`, in index order, or null if they could not be read (P9.25). */
  records: EvmRecord[] | null;
  /** Records seen above `block` (observed, never accepted; P9.22), for pending labels. */
  observed?: EvmRecord[];
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
