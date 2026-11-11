/**
 * A minimal Ethereum JSON-RPC client over an injected `fetch` (originals-spec
 * PR 59, P9.21, P9.22). EXPERIMENTAL. Browser-safe: no Node builtins, and the
 * caller supplies `fetch` (the global one by default).
 *
 * State reads name their block by hash (EIP-1898 `{ blockHash }`), so every
 * read of one provider is of exactly the block the reader chose, even if the
 * chain moves while it reads.
 */
import { OriginalsError } from "@originals/vh";
import { decodeArgs, encodeCall, fromHex, quantity, toHex, toQuantity, type AbiType, type AbiValue } from "./evm-abi.js";

/** The part of `fetch` the client uses. */
export type EvmFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A block to read state at: a tag, a number, or (preferred) a hash (EIP-1898). */
export type BlockRef = "latest" | "finalized" | "pending" | number | { blockHash: string };

/** The node answered with a JSON-RPC error that is an EVM revert (an `eth_call` that reverted). */
export class EvmRevert extends Error {
  constructor(
    message: string,
    readonly data?: string,
  ) {
    super(message);
    this.name = "EvmRevert";
  }
}

export interface EvmBlock {
  number: number;
  hash: string;
  timestamp: number;
}

export interface EvmReceipt {
  transactionHash: string;
  status: "success" | "reverted";
  blockNumber: number;
  blockHash: string;
  gasUsed: bigint;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export interface EvmRpcOptions {
  fetch?: EvmFetch;
  signal?: AbortSignal;
}

function unavailable(url: string, message: string): never {
  throw new OriginalsError("incomplete-evidence", "EVM_PROVIDER_UNAVAILABLE", `${url}: ${message}`, { provider: url });
}

function answer(url: string, message: string): never {
  throw new OriginalsError("incomplete-evidence", "EVM_RPC_ANSWER", `${url}: ${message}`, { provider: url });
}

const blockParam = (b: BlockRef): unknown => (typeof b === "number" ? toQuantity(b) : b);

const HASH = /^0x[0-9a-fA-F]{64}$/;

export class EvmRpc {
  private id = 0;
  private readonly fetcher: EvmFetch;

  constructor(
    readonly url: string,
    private readonly options: EvmRpcOptions = {},
  ) {
    const f = options.fetch ?? (globalThis.fetch);
    if (!f) throw new OriginalsError("incomplete-evidence", "EVM_FETCH_REQUIRED", "no fetch is available; pass one");
    this.fetcher = f;
  }

  async request<T = unknown>(method: string, params: unknown[]): Promise<T> {
    let response: Awaited<ReturnType<EvmFetch>>;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      });
    } catch (error) {
      return unavailable(this.url, `${method} failed: ${(error as Error)?.message ?? String(error)}`);
    }
    if (!response.ok) unavailable(this.url, `${method} answered HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return answer(this.url, `${method} answered with no JSON`);
    }
    if (typeof body !== "object" || body === null) answer(this.url, `${method} answered with no JSON-RPC object`);
    const b = body as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    if (b.error) {
      const message = typeof b.error.message === "string" ? b.error.message : "error";
      const data = typeof b.error.data === "string" ? b.error.data : undefined;
      // Geth and anvil answer a reverted eth_call / eth_estimateGas with code 3 or "execution reverted".
      if (b.error.code === 3 || /revert/i.test(message)) throw new EvmRevert(`${this.url}: ${method}: ${message}`, data);
      return unavailable(this.url, `${method}: ${message}`);
    }
    if (!("result" in b)) answer(this.url, `${method} answered with no result`);
    return b.result as T;
  }

  async chainId(): Promise<bigint> {
    return quantity(await this.request("eth_chainId", []), "eth_chainId");
  }

  /** A block's number, hash and timestamp, or null when the node has none for that tag or number. */
  async block(ref: "latest" | "finalized" | number): Promise<EvmBlock | null> {
    const b = await this.request<{ number?: unknown; hash?: unknown; timestamp?: unknown } | null>("eth_getBlockByNumber", [blockParam(ref), false]);
    if (b === null) return null;
    if (typeof b !== "object" || typeof b.hash !== "string" || !HASH.test(b.hash)) answer(this.url, "eth_getBlockByNumber answered with no block hash");
    const number = Number(quantity(b.number, "block number"));
    if (typeof ref === "number" && number !== ref) answer(this.url, `eth_getBlockByNumber(${ref}) answered block ${number}`);
    return { number, hash: b.hash.toLowerCase(), timestamp: Number(quantity(b.timestamp, "block timestamp")) };
  }

  async code(address: string, at: BlockRef): Promise<Uint8Array> {
    return fromHex(await this.request<string>("eth_getCode", [address, blockParam(at)]));
  }

  /** `eth_call` of `signature` on `to` at `at`, decoded as `returns`. Throws `EvmRevert` when it reverts. */
  async call(to: string, signature: string, types: readonly AbiType[], values: readonly AbiValue[], returns: readonly AbiType[], at: BlockRef): Promise<AbiValue[]> {
    const data = toHex(encodeCall(signature, types, values));
    const result = await this.request<string>("eth_call", [{ to, data }, blockParam(at)]);
    return decodeArgs(returns, fromHex(result));
  }

  async transaction(hash: string): Promise<{ blockNumber: number | null } | null> {
    const tx = await this.request<{ blockNumber?: unknown } | null>("eth_getTransactionByHash", [hash]);
    if (tx === null) return null;
    return { blockNumber: tx.blockNumber === null || tx.blockNumber === undefined ? null : Number(quantity(tx.blockNumber, "blockNumber")) };
  }

  async receipt(hash: string): Promise<EvmReceipt | null> {
    const r = await this.request<Record<string, unknown> | null>("eth_getTransactionReceipt", [hash]);
    if (r === null) return null;
    const logs = Array.isArray(r.logs) ? (r.logs as Array<{ address: string; topics: string[]; data: string }>) : [];
    return {
      transactionHash: String(r.transactionHash),
      status: quantity(r.status, "receipt status") === 1n ? "success" : "reverted",
      blockNumber: Number(quantity(r.blockNumber, "receipt blockNumber")),
      blockHash: String(r.blockHash).toLowerCase(),
      gasUsed: quantity(r.gasUsed, "receipt gasUsed"),
      logs: logs.map((l) => ({ address: String(l.address).toLowerCase(), topics: l.topics.map((t) => t.toLowerCase()), data: l.data })),
    };
  }
}
