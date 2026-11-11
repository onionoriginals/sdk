/**
 * Writing to the anchor contract (originals-spec PR 59, P9.23-P9.25, P9.27,
 * P14.19, P14.20). EXPERIMENTAL; the spec pins no contract (P14.21), so the
 * caller supplies an `EvmAnchorPin`.
 *
 * The SDK never holds a key: the caller injects an `EvmWallet` that signs
 * and sends a transaction and returns its hash. The SDK reads receipts over
 * JSON-RPC. Before any transaction it checks that the provider serves the
 * listed chain (chain ID and block-0 hash, P9.21) and that the code at the
 * pinned address has the pinned hash, so it never publishes to another
 * contract.
 *
 * - `mintEvmToken`: `mint(keccak256(did:vh))` from the minter the anchor
 *   member names (P14.19). Any other sender would mint another token.
 * - `prepareEvmPublication` and `submitEvmPublication`: publish the given
 *   log lines as the CBOR metadata (P14.12) and the given bytes as the body.
 *   The body must be the version the last line names (P14.20). When the
 *   token already stores those bytes, the publication refers to them
 *   (`publishSameBody`, P14.20 SHOULD). When the payload is larger than
 *   `maxTxBytes`, it is uploaded in stages: `begin`, `append`s and
 *   `commit`/`commitSameBody`. Which lines to publish is the caller's choice:
 *   the whole log through the anchoring entry for the anchoring publication,
 *   one entry after it, the whole log through a move entry for an arrival
 *   (P9.17, P9.29). Removing a carried-log carrier is not done here.
 * - `evmPublicationStatus`: the P9.18 labels read through P9.27. A publication
 *   is `pending-evm-finality` while a provider's pool holds its transactions
 *   or once they are in a block that is not yet finalized, and
 *   `submitted-unobserved` otherwise. The label names are PROVISIONAL.
 */
import { OriginalsError } from "@originals/vh";
import {
  ORIGINALS_INSCRIPTION_MAX_BYTES,
  evmAliasOf,
  originalHash,
  requireSupported,
  resourceDigest,
  tokenIdOf,
  parseEvmAlias,
  checkAnchor,
  type EvmAnchor,
  type EvmAnchorPin,
  type ResourceDescriptor,
} from "@originals/vh/originals";
import { concatBytes, encodeCall, eventTopic, fromHex, keccakHex, toHex } from "./evm-abi.js";
import { EvmRevert, EvmRpc, type EvmFetch, type EvmReceipt } from "./evm-rpc.js";
import { ANCHOR_READS, EVM_MAX_MEDIA_TYPE_BYTES } from "./evm-reader.js";
import { descriptorOfLine, inscriptionMetadata } from "./inscription.js";
import { evmPublicationNotice, versionIdOfLine, type EvmPublicationNotice } from "./evm-notice.js";

/** A transaction for the wallet to sign and send. The wallet sets gas, fees and nonce. */
export interface EvmTransactionRequest {
  from: string;
  to: string;
  data: string;
  chainId: bigint;
}

/** An injected signer: the SDK never sees its key. */
export interface EvmWallet {
  /** The sending address, 0x and 40 hex digits. */
  address: string;
  /** Sign and broadcast; resolve to the transaction hash. */
  sendTransaction(tx: EvmTransactionRequest): Promise<string>;
}

export interface EvmWriterContext {
  /** The chain to write to, `eip155:<id>`; must be listed in the pin's chains (P9.19, P14.22). */
  chain: string;
  pin: EvmAnchorPin;
  wallet: EvmWallet;
  /** A JSON-RPC endpoint for the chain, used for checks, reads and receipts. */
  rpc: string;
  fetch?: EvmFetch;
  /** Receipt polling interval, ms. Default 1,000. */
  pollMs?: number;
  /** How long to wait for a receipt, ms. Default 120,000. */
  timeoutMs?: number;
  /** Injected for tests. Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** The anchor contract's write interface (P14.20, P14.19), and the events the writer reads from receipts. */
export const ANCHOR_WRITES = {
  mint: "mint(bytes32)",
  publish: "publish(uint256,string,bytes,bytes)",
  publishSameBody: "publishSameBody(uint256,bytes,uint32)",
  begin: "begin(uint256)",
  append: "append(bytes32,bytes)",
  commit: "commit(bytes32,string,uint32)",
  commitSameBody: "commitSameBody(bytes32,uint32)",
} as const;

export const ANCHOR_EVENTS = {
  Transfer: eventTopic("Transfer(address,address,uint256)"),
  Published: eventTopic("Published(uint256,uint32)"),
  /** PROVISIONAL extension of P14.20: how a writer learns the upload `begin` opened. */
  UploadBegun: eventTopic("UploadBegun(bytes32,uint256,address)"),
} as const;

/**
 * PROVISIONAL default for the bytes one transaction stores. Each stored byte
 * costs about 220 gas, so EIP-7825's 16,777,216-gas transaction cap allows
 * about 74 kB, and geth's pool takes transactions up to 128 KiB. 60,000
 * leaves room for both.
 */
export const EVM_DEFAULT_MAX_TX_BYTES = 60_000;

function refuse(category: ConstructorParameters<typeof OriginalsError>[0], code: string, message: string, details?: Record<string, unknown>): never {
  throw new OriginalsError(category, code, message, details);
}

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const addressWord = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

interface Target {
  rpc: EvmRpc;
  chainId: bigint;
  from: string;
}

/** P9.21: the provider serves the listed chain and the pinned code is at the pinned address. */
async function target(ctx: EvmWriterContext): Promise<Target> {
  const { listed } = requireSupported(ctx.chain, ctx.pin);
  const rpc = new EvmRpc(ctx.rpc, ctx.fetch ? { fetch: ctx.fetch } : {});
  const chainId = await rpc.chainId();
  const genesis = await rpc.block(0);
  if (chainId !== listed.chainId || genesis?.hash !== listed.genesisHash.toLowerCase()) {
    refuse("unsupported-profile", "EVM_WRONG_CHAIN", `${ctx.rpc} does not serve ${listed.name} (${listed.chain}): chain ID ${chainId}, block 0 ${genesis?.hash ?? "none"} (P9.21)`);
  }
  const code = await rpc.code(ctx.pin.address, "latest");
  const codeHash = code.length === 0 ? null : keccakHex(code);
  if (codeHash !== ctx.pin.codeHash.toLowerCase()) {
    refuse("unsupported-profile", "EVM_ANCHOR_CODE", `the code at ${ctx.pin.address} on ${listed.chain} is ${codeHash ?? "absent"}, not the pinned ${ctx.pin.codeHash} (P9.21)`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(ctx.wallet.address)) refuse("invalid-evidence", "INPUT_INVALID", "wallet.address is 0x and 40 hex digits");
  return { rpc, chainId, from: ctx.wallet.address.toLowerCase() };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for a transaction's receipt. A timeout is not a failure of the transaction: check `evmPublicationStatus`. */
export async function waitForEvmReceipt(rpc: EvmRpc, hash: string, options: Pick<EvmWriterContext, "pollMs" | "timeoutMs" | "sleep"> = {}): Promise<EvmReceipt> {
  const poll = options.pollMs ?? 1_000;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const sleep = options.sleep ?? defaultSleep;
  for (;;) {
    const r = await rpc.receipt(hash);
    if (r) return r;
    if (Date.now() >= deadline) refuse("incomplete-evidence", "EVM_RECEIPT_TIMEOUT", `no receipt for ${hash} yet; it may still be pending (P9.27)`, { hash });
    await sleep(poll);
  }
}

async function send(ctx: EvmWriterContext, t: Target, data: Uint8Array, what: string): Promise<EvmReceipt> {
  const hash = await ctx.wallet.sendTransaction({ from: t.from, to: ctx.pin.address, data: toHex(data), chainId: t.chainId });
  const receipt = await waitForEvmReceipt(t.rpc, hash, ctx);
  if (receipt.status !== "success") refuse("invalid-evidence", "EVM_TX_REVERTED", `${what} (${hash}) reverted`, { hash, what });
  return receipt;
}

export interface MintResult {
  tokenId: bigint;
  /** The token alias, did:evm (P14.18). */
  alias: string;
  /** Null when the token already existed (minting reverts then, P14.19). */
  txHash: string | null;
  owner: string;
  gasUsed: bigint;
}

/** P14.19: mint the Original's token from its minter. Returns the existing token if it was minted before. */
export async function mintEvmToken(ctx: EvmWriterContext, input: { original: string; anchor: EvmAnchor }): Promise<MintResult> {
  const anchor = checkAnchor(input.anchor, "anchor");
  if (anchor.chain !== ctx.chain) refuse("invalid-evidence", "EVM_WRONG_CHAIN", `the anchor member names ${anchor.chain}, not ${ctx.chain}`);
  const t = await target(ctx);
  if (t.from !== anchor.minter) {
    refuse("invalid-evidence", "EVM_WRONG_MINTER", `the wallet ${t.from} is not the minter ${anchor.minter}: it would mint another token, which is not the Original's (P14.19, P9.24)`);
  }
  const tokenId = tokenIdOf(input.original, anchor.minter);
  const alias = evmAliasOf(anchor.chain, ctx.pin.address, tokenId);
  try {
    const [owner] = await t.rpc.call(ctx.pin.address, ANCHOR_READS.ownerOf, ["uint256"], [tokenId], ["address"], "latest");
    return { tokenId, alias, txHash: null, owner: owner as string, gasUsed: 0n };
  } catch (error) {
    if (!(error instanceof EvmRevert)) throw error;
  }
  const receipt = await send(ctx, t, encodeCall(ANCHOR_WRITES.mint, ["bytes32"], [originalHash(input.original)]), "mint");
  const minted = receipt.logs.some((l) => l.address === ctx.pin.address && l.topics[0] === ANCHOR_EVENTS.Transfer && l.topics[3] === word(tokenId));
  if (!minted) refuse("incomplete-evidence", "EVM_MINT_UNSEEN", `the mint receipt ${receipt.transactionHash} shows no transfer of token ${tokenId}`);
  return { tokenId, alias, txHash: receipt.transactionHash, owner: t.from, gasUsed: receipt.gasUsed };
}

export interface PrepareEvmPublicationInput {
  /** The token alias (P14.18) to publish on. */
  alias: string;
  /** The exact stored log lines to carry, in order (P9.17, P14.12). */
  lines: readonly string[];
  /** The exact bytes of the resource version the last line names (P9.17, P14.20). */
  body: Uint8Array;
  /**
   * Refer to a body the token already stores (P14.20 SHOULD): `"auto"` (the
   * default) finds the earliest record that stored these exact bytes; a
   * number names that record; `false` always stores the body.
   */
  sameBody?: "auto" | number | false;
  /** Bytes per transaction before uploading in stages. Default `EVM_DEFAULT_MAX_TX_BYTES`. */
  maxTxBytes?: number;
}

export interface PreparedEvmPublication {
  alias: string;
  tokenId: bigint;
  metadata: Uint8Array;
  body: Uint8Array;
  version: ResourceDescriptor;
  /** The record whose stored body this publication refers to, or null when it stores its own. */
  sameBodyOf: number | null;
  /** The bytes the publication stores (P9.25). */
  storedBytes: number;
  /** One transaction, or `begin` + appends + commit. */
  plan: { kind: "publish" | "publishSameBody" } | { kind: "staged"; appends: number; commit: "commit" | "commitSameBody" };
  maxTxBytes: number;
  /** What to tell the author first (P9.18 read through P9.20). */
  notice: EvmPublicationNotice;
}

/**
 * Check a publication and plan its transactions, reading the token at
 * `latest` to find a stored body. Nothing is sent.
 */
export async function prepareEvmPublication(ctx: EvmWriterContext, input: PrepareEvmPublicationInput): Promise<PreparedEvmPublication> {
  const parsed = parseEvmAlias(input.alias);
  if (parsed.chain !== ctx.chain || parsed.contract !== ctx.pin.address) refuse("invalid-evidence", "EVM_ALIAS_CONTRACT", `${input.alias} is not a token of the pinned contract on ${ctx.chain} (P14.18)`);
  if (input.lines.length === 0) refuse("invalid-evidence", "INPUT_INVALID", "a publication carries at least one entry (P9.17)");
  if (!(input.body instanceof Uint8Array)) refuse("invalid-evidence", "INPUT_INVALID", "body is a Uint8Array");
  const version = descriptorOfLine(input.lines[input.lines.length - 1]);
  // P14.20: the body is the exact bytes of the version the last entry names, under its media type.
  if (input.body.length !== version.size || resourceDigest(input.body) !== version.digest) {
    refuse("invalid-evidence", "EVM_BODY_MISMATCH", `the body is not the resource version ${version.digest} the last entry names (P9.17, P14.20)`);
  }
  if (new TextEncoder().encode(version.mediaType).length > EVM_MAX_MEDIA_TYPE_BYTES) {
    refuse("limit-exceeded", "EVM_MEDIA_TYPE_TOO_LONG", `the media type is longer than ${EVM_MAX_MEDIA_TYPE_BYTES} bytes (P14.20)`);
  }
  const maxTxBytes = input.maxTxBytes ?? EVM_DEFAULT_MAX_TX_BYTES;
  if (!Number.isSafeInteger(maxTxBytes) || maxTxBytes < 1) refuse("invalid-evidence", "INPUT_INVALID", "maxTxBytes is a positive integer");
  const metadata = inscriptionMetadata(input.lines);
  const t = await target(ctx);
  const sameBodyOf = await storedBody(t, ctx.pin.address, parsed.tokenId, input.body, version, input.sameBody ?? "auto");
  const storedBytes = sameBodyOf === null ? metadata.length + input.body.length : metadata.length;
  if (storedBytes > ORIGINALS_INSCRIPTION_MAX_BYTES) {
    refuse("limit-exceeded", "PUBLICATION_TOO_LARGE", `the publication would store ${storedBytes} bytes; the anchor contract holds at most ${ORIGINALS_INSCRIPTION_MAX_BYTES} per publication (P9.25, P14.20)`, { size: storedBytes, limit: ORIGINALS_INSCRIPTION_MAX_BYTES });
  }
  const commit = sameBodyOf === null ? "commit" : "commitSameBody";
  const plan: PreparedEvmPublication["plan"] =
    storedBytes <= maxTxBytes ? { kind: sameBodyOf === null ? "publish" : "publishSameBody" } : { kind: "staged", appends: Math.ceil(storedBytes / maxTxBytes), commit };
  const notice = evmPublicationNotice(ctx.chain, ctx.pin, input.lines.map(versionIdOfLine), version);
  return { alias: input.alias, tokenId: parsed.tokenId, metadata, body: input.body, version, sameBodyOf, storedBytes, plan, maxTxBytes, notice };
}

/** The earliest record of the token that stored exactly these bytes, or null (P14.20). */
async function storedBody(t: Target, address: string, tokenId: bigint, body: Uint8Array, version: ResourceDescriptor, choice: "auto" | number | false): Promise<number | null> {
  if (choice === false) return null;
  const fields = async (i: number) => {
    const [, , bodyLength, bodyOf, mediaType] = await t.rpc.call(address, ANCHOR_READS.publication, ["uint256", "uint32"], [tokenId, i], ["uint64", "uint32", "uint32", "uint32", "string"], "latest");
    return { bodyLength: Number(bodyLength), bodyOf: Number(bodyOf), mediaType: mediaType as string };
  };
  const same = async (i: number) => {
    const f = await fields(i);
    if (f.bodyOf !== i || f.bodyLength !== body.length || f.mediaType !== version.mediaType) return false;
    const [bytes] = await t.rpc.call(address, ANCHOR_READS.body, ["uint256", "uint32", "uint32", "uint32"], [tokenId, i, 0, body.length], ["bytes"], "latest");
    return resourceDigest(bytes as Uint8Array) === version.digest;
  };
  const [count] = await t.rpc.call(address, ANCHOR_READS.publicationCount, ["uint256"], [tokenId], ["uint32"], "latest");
  if (typeof choice === "number") {
    if (!Number.isInteger(choice) || choice < 0 || choice >= Number(count) || !(await same(choice))) {
      refuse("invalid-evidence", "EVM_NOT_STORED_BODY", `record ${choice} is not a record of this token that stored this body (P14.20)`);
    }
    return choice;
  }
  for (let i = 0; i < Number(count); i++) if (await same(i)) return i;
  return null;
}

export interface EvmPublicationResult {
  alias: string;
  /** The record's index on the token (P14.20). */
  index: number;
  /** Every transaction, in order: one, or `begin`, the appends and the commit. */
  txHashes: string[];
  gasUsed: bigint;
  sameBodyOf: number | null;
  /** The receipt's block. The publication counts only once that block is finalized (P9.22). */
  block: { number: number; hash: string };
}

/**
 * Send a prepared publication. Each transaction waits for its receipt before
 * the next is sent. A staged upload that fails before its commit is never a
 * record and is ignored (P14.20); preparing again starts a new upload.
 */
export async function submitEvmPublication(ctx: EvmWriterContext, prepared: PreparedEvmPublication): Promise<EvmPublicationResult> {
  const t = await target(ctx);
  const { tokenId, metadata, body, sameBodyOf, plan, version } = prepared;
  const receipts: EvmReceipt[] = [];
  if (plan.kind === "publish") {
    receipts.push(await send(ctx, t, encodeCall(ANCHOR_WRITES.publish, ["uint256", "string", "bytes", "bytes"], [tokenId, version.mediaType, metadata, body]), "publish"));
  } else if (plan.kind === "publishSameBody") {
    receipts.push(await send(ctx, t, encodeCall(ANCHOR_WRITES.publishSameBody, ["uint256", "bytes", "uint32"], [tokenId, metadata, sameBodyOf!]), "publishSameBody"));
  } else {
    const begun = await send(ctx, t, encodeCall(ANCHOR_WRITES.begin, ["uint256"], [tokenId]), "begin");
    receipts.push(begun);
    const log = begun.logs.find((l) => l.address === ctx.pin.address && l.topics[0] === ANCHOR_EVENTS.UploadBegun && l.topics[2] === word(tokenId) && l.topics[3] === addressWord(t.from));
    if (!log) refuse("incomplete-evidence", "EVM_UPLOAD_UNSEEN", `the begin receipt ${begun.transactionHash} names no upload`);
    const upload = fromHex(log.topics[1]);
    const payload = sameBodyOf === null ? concatBytes(metadata, body) : metadata;
    for (let at = 0; at < payload.length; at += prepared.maxTxBytes) {
      const part = payload.slice(at, at + prepared.maxTxBytes);
      receipts.push(await send(ctx, t, encodeCall(ANCHOR_WRITES.append, ["bytes32", "bytes"], [upload, part]), `append at ${at}`));
    }
    receipts.push(
      sameBodyOf === null
        ? await send(ctx, t, encodeCall(ANCHOR_WRITES.commit, ["bytes32", "string", "uint32"], [upload, version.mediaType, metadata.length]), "commit")
        : await send(ctx, t, encodeCall(ANCHOR_WRITES.commitSameBody, ["bytes32", "uint32"], [upload, sameBodyOf]), "commitSameBody"),
    );
  }
  const last = receipts[receipts.length - 1];
  const published = last.logs.find((l) => l.address === ctx.pin.address && l.topics[0] === ANCHOR_EVENTS.Published && l.topics[1] === word(tokenId));
  if (!published) refuse("incomplete-evidence", "EVM_PUBLICATION_UNSEEN", `the receipt ${last.transactionHash} shows no publication on token ${tokenId}`);
  const index = Number(BigInt(published.data));
  return {
    alias: prepared.alias,
    index,
    txHashes: receipts.map((r) => r.transactionHash),
    gasUsed: receipts.reduce((n, r) => n + r.gasUsed, 0n),
    sameBodyOf,
    block: { number: last.blockNumber, hash: last.blockHash },
  };
}

/** P9.18 labels read through P9.27, per transaction and for a whole publication. PROVISIONAL names. */
export type EvmTxStatus = "finalized" | "pending-evm-finality" | "submitted-unobserved" | "reverted";

/**
 * The status of a publication's transactions on one provider. Reverted wins,
 * then unobserved, then pending: a publication is `pending-evm-finality` only
 * while every transaction is in the pool or in a block not yet finalized, and
 * is never presented as on its way otherwise (P9.18, P9.27).
 */
export async function evmPublicationStatus(rpcUrl: string, txHashes: readonly string[], options: { fetch?: EvmFetch } = {}): Promise<{ status: EvmTxStatus; transactions: Array<{ hash: string; status: EvmTxStatus }>; finalized: number | null }> {
  const rpc = new EvmRpc(rpcUrl, options.fetch ? { fetch: options.fetch } : {});
  const finalized = (await rpc.block("finalized"))?.number ?? null;
  const transactions: Array<{ hash: string; status: EvmTxStatus }> = [];
  for (const hash of txHashes) {
    const receipt = await rpc.receipt(hash);
    let status: EvmTxStatus;
    if (receipt) status = receipt.status === "reverted" ? "reverted" : finalized !== null && receipt.blockNumber <= finalized ? "finalized" : "pending-evm-finality";
    else status = (await rpc.transaction(hash)) ? "pending-evm-finality" : "submitted-unobserved";
    transactions.push({ hash, status });
  }
  const rank: EvmTxStatus[] = ["reverted", "submitted-unobserved", "pending-evm-finality", "finalized"];
  const status = transactions.length === 0 ? "submitted-unobserved" : rank.find((s) => transactions.some((t) => t.status === s))!;
  return { status, transactions, finalized };
}

