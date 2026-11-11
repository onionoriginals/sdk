/**
 * A fake EVM JSON-RPC provider for unit tests of the EVM adapters: an anchor
 * contract's records per token, each with the block that recorded it, served
 * through `eth_call` at a block hash (EIP-1898) like a node would.
 */
import { decodeArgs, encodeArgs, keccakHex, selector, toHex, fromHex, type AbiType } from "../../../src/originals/evm-abi.js";
import type { EvmFetch } from "../../../src/originals/evm-rpc.js";

export interface FakeRecord {
  block: number;
  timestamp: number;
  mediaType: string;
  metadata: Uint8Array;
  body: Uint8Array;
  /** Own index (stored) or an earlier one. */
  bodyOf?: number;
  /** Override the reported lengths (to fake records over the limit). */
  metadataLength?: number;
  bodyLength?: number;
}

export interface FakeChain {
  chainId: bigint;
  genesisHash: string;
  finalized: number;
  latest: number;
  /** The code at the anchor address; empty for none. */
  code: Uint8Array;
  address: string;
  owners: Map<bigint, string>;
  records: Map<bigint, FakeRecord[]>;
  /** Seeds block hashes; a different value models a provider on another fork. */
  fork?: string;
  /** Return fewer bytes than asked from ranged reads. */
  shortRanges?: boolean;
  down?: boolean;
  /** Pool and receipts for status tests. */
  pool?: Set<string>;
  receipts?: Map<string, { block: number; status: 1 | 0 }>;
}

export const blockHash = (chain: Pick<FakeChain, "fork">, n: number) => keccakHex(new TextEncoder().encode(`${chain.fork ?? "main"}:${n}`));

const SIG = (s: string) => toHex(selector(s));
const SELECTORS: Record<string, { name: string; args: AbiType[] }> = {
  [SIG("ownerOf(uint256)")]: { name: "ownerOf", args: ["uint256"] },
  [SIG("publicationCount(uint256)")]: { name: "publicationCount", args: ["uint256"] },
  [SIG("publication(uint256,uint32)")]: { name: "publication", args: ["uint256", "uint32"] },
  [SIG("metadata(uint256,uint32,uint32,uint32)")]: { name: "metadata", args: ["uint256", "uint32", "uint32", "uint32"] },
  [SIG("body(uint256,uint32,uint32,uint32)")]: { name: "body", args: ["uint256", "uint32", "uint32", "uint32"] },
};

export interface Call {
  method: string;
  name?: string;
  args?: unknown[];
}

class Revert extends Error {}

export function fakeProvider(chain: FakeChain, calls: Call[] = []): EvmFetch {
  const blockOf = (param: unknown): number => {
    if (param === "latest") return chain.latest;
    if (param === "finalized") return chain.finalized;
    if (typeof param === "string") return Number(BigInt(param));
    const hash = (param as { blockHash: string }).blockHash;
    for (let n = 0; n <= chain.latest; n++) if (blockHash(chain, n) === hash) return n;
    throw new Error(`unknown block ${hash}`);
  };
  const handle = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "eth_chainId":
        return `0x${chain.chainId.toString(16)}`;
      case "eth_getBlockByNumber": {
        const n = blockOf(params[0]);
        if (n > chain.latest) return null;
        return { number: `0x${n.toString(16)}`, hash: n === 0 ? chain.genesisHash : blockHash(chain, n), timestamp: `0x${(1_800_000_000 + n).toString(16)}` };
      }
      case "eth_getCode":
        blockOf(params[1]);
        return params[0] === chain.address ? toHex(chain.code) : "0x";
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: string };
        const at = blockOf(params[1]);
        if (to !== chain.address || chain.code.length === 0) return "0x";
        const fn = SELECTORS[data.slice(0, 10)];
        if (!fn) throw new Error(`unknown selector ${data.slice(0, 10)}`);
        const args = decodeArgs(fn.args, fromHex(`0x${data.slice(10)}`));
        calls.push({ method, name: fn.name, args });
        const tokenId = args[0] as bigint;
        const recs = (chain.records.get(tokenId) ?? []).filter((r) => r.block <= at);
        const rec = (i: number) => {
          if (i >= recs.length) throw new Revert("NoSuchRecord");
          return recs[i];
        };
        const lengths = (r: FakeRecord) => ({ ml: r.metadataLength ?? r.metadata.length, bl: r.bodyLength ?? r.body.length });
        const range = (bytes: Uint8Array, offset: number, length: number) => {
          const out = bytes.slice(offset, offset + length);
          return chain.shortRanges && out.length > 1 ? out.slice(0, out.length - 1) : out;
        };
        switch (fn.name) {
          case "ownerOf": {
            const owner = chain.owners.get(tokenId);
            if (!owner) throw new Revert("NonexistentToken");
            return toHex(encodeArgs(["address"], [owner]));
          }
          case "publicationCount":
            return toHex(encodeArgs(["uint32"], [recs.length]));
          case "publication": {
            const i = Number(args[1]);
            const r = rec(i);
            const ref = recs[r.bodyOf ?? i] ?? r;
            return toHex(encodeArgs(["uint64", "uint32", "uint32", "uint32", "string"], [r.timestamp, lengths(r).ml, lengths(ref).bl, r.bodyOf ?? i, ref.mediaType]));
          }
          case "metadata": {
            const r = rec(Number(args[1]));
            return toHex(encodeArgs(["bytes"], [range(r.metadata, Number(args[2]), Number(args[3]))]));
          }
          case "body": {
            const i = Number(args[1]);
            const ref = recs[rec(i).bodyOf ?? i];
            return toHex(encodeArgs(["bytes"], [range(ref.body, Number(args[2]), Number(args[3]))]));
          }
        }
        throw new Error("unreachable");
      }
      case "eth_getTransactionReceipt": {
        const r = chain.receipts?.get(params[0] as string);
        if (!r) return null;
        return { transactionHash: params[0], status: `0x${r.status}`, blockNumber: `0x${r.block.toString(16)}`, blockHash: blockHash(chain, r.block), gasUsed: "0x5208", logs: [] };
      }
      case "eth_getTransactionByHash": {
        const hash = params[0] as string;
        if (chain.pool?.has(hash)) return { hash, blockNumber: null };
        const r = chain.receipts?.get(hash);
        return r ? { hash, blockNumber: `0x${r.block.toString(16)}` } : null;
      }
    }
    throw new Error(`unsupported ${method}`);
  };
  return (_url, init) => {
    const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    if (method !== "eth_call") calls.push({ method });
    if (chain.down) return Promise.reject(new Error("connection refused"));
    let payload: unknown;
    try {
      payload = { jsonrpc: "2.0", id, result: handle(method, params) };
    } catch (error) {
      if (!(error instanceof Revert)) throw error;
      payload = { jsonrpc: "2.0", id, error: { code: 3, message: `execution reverted: ${error.message}` } };
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
}

/** Route several fake providers by URL. */
export function fakeNetwork(byUrl: Record<string, EvmFetch>): EvmFetch {
  return (url, init) => {
    const f = byUrl[url];
    if (!f) return Promise.reject(new Error(`no provider at ${url}`));
    return f(url, init);
  };
}
