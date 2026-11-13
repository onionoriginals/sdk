/**
 * A fake EVM JSON-RPC provider for unit tests of the EVM adapters: an anchor
 * contract's records per token, each with the block that recorded it, served
 * through `eth_call` at a block hash (EIP-1898) like a node would.
 */
import { decodeArgs, encodeArgs, keccakHex, selector, toHex, fromHex, type AbiType } from "../../../src/originals/evm-abi.js";
import type { EvmFetch } from "../../../src/originals/evm-rpc.js";
import type { EvmTransactionRequest, EvmWallet } from "../../../src/originals/evm-writer.js";

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
  /** State is kept only from this block on: reads at earlier blocks fail as a pruned node's do (P9.22). */
  stateFrom?: number;
  /** Pool and receipts for status tests. */
  pool?: Set<string>;
  receipts?: Map<string, { block: number; status: 1 | 0; logs?: Array<{ address: string; topics: string[]; data: string }> }>;
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
class Pruned extends Error {}

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
        if (chain.stateFrom !== undefined && blockOf(params[1]) < chain.stateFrom) throw new Pruned("missing trie node");
        return params[0] === chain.address ? toHex(chain.code) : "0x";
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: string };
        const at = blockOf(params[1]);
        if (chain.stateFrom !== undefined && at < chain.stateFrom) throw new Pruned("missing trie node");
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
        return { transactionHash: params[0], status: `0x${r.status}`, blockNumber: `0x${r.block.toString(16)}`, blockHash: blockHash(chain, r.block), gasUsed: "0x5208", logs: r.logs ?? [] };
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
      if (error instanceof Pruned) payload = { jsonrpc: "2.0", id, error: { code: -32000, message: error.message } };
      else if (!(error instanceof Revert)) throw error;
      else payload = { jsonrpc: "2.0", id, error: { code: 3, message: `execution reverted: ${error.message}` } };
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

const WRITES: Record<string, { name: string; args: AbiType[] }> = {
  [SIG("mint(bytes32)")]: { name: "mint", args: ["bytes32"] },
  [SIG("publish(uint256,string,bytes,bytes)")]: { name: "publish", args: ["uint256", "string", "bytes", "bytes"] },
  [SIG("publishSameBody(uint256,bytes,uint32)")]: { name: "publishSameBody", args: ["uint256", "bytes", "uint32"] },
  [SIG("begin(uint256)")]: { name: "begin", args: ["uint256"] },
  [SIG("append(bytes32,bytes)")]: { name: "append", args: ["bytes32", "bytes"] },
  [SIG("commit(bytes32,string,uint32)")]: { name: "commit", args: ["bytes32", "string", "uint32"] },
  [SIG("commitSameBody(bytes32,uint32)")]: { name: "commitSameBody", args: ["bytes32", "uint32"] },
};
const topic = (s: string) => keccakHex(new TextEncoder().encode(s));
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

/**
 * A wallet that executes its transactions on a fake anchor contract (P14.19,
 * P14.20): each is mined in a block of its own, above the finalized block,
 * with the contract's events in its receipt. Only the holder may publish; a
 * transaction that breaks a rule is mined as reverted. `sent` lists what it
 * sent, by function name.
 */
export function fakeWallet(chain: FakeChain, address: string, sent: string[] = []): EvmWallet & { sent: string[] } {
  chain.receipts ??= new Map();
  const uploads = new Map<string, { tokenId: bigint; by: string; data: Uint8Array }>();
  let n = 0;
  const holderOk = (tokenId: bigint, from: string) => chain.owners.get(tokenId)?.toLowerCase() === from.toLowerCase();
  const record = (tokenId: bigint, r: Omit<FakeRecord, "block" | "timestamp">) => {
    const list = chain.records.get(tokenId) ?? [];
    const block = chain.latest;
    list.push({ ...r, block, timestamp: 1_800_000_000 + block });
    chain.records.set(tokenId, list);
    return list.length - 1;
  };
  const sameBodyOk = (tokenId: bigint, of: number) => {
    const r = (chain.records.get(tokenId) ?? [])[of];
    return r !== undefined && (r.bodyOf ?? of) === of;
  };
  const execute = (tx: EvmTransactionRequest): { ok: boolean; logs: Array<{ address: string; topics: string[]; data: string }> } => {
    if (tx.to !== chain.address || BigInt(tx.chainId) !== chain.chainId) return { ok: false, logs: [] };
    const fn = WRITES[tx.data.slice(0, 10)];
    if (!fn) return { ok: false, logs: [] };
    const args = decodeArgs(fn.args, fromHex(`0x${tx.data.slice(10)}`));
    const from = tx.from.toLowerCase();
    const published = (tokenId: bigint, index: number) => ({ ok: true, logs: [{ address: chain.address, topics: [topic("Published(uint256,uint32)"), word(tokenId)], data: word(BigInt(index)) }] });
    switch (fn.name) {
      case "mint": {
        const tokenId = BigInt(keccakHex(encodeArgs(["bytes32", "address"], [args[0] as Uint8Array, from])));
        if (chain.owners.has(tokenId)) return { ok: false, logs: [] };
        chain.owners.set(tokenId, from);
        return { ok: true, logs: [{ address: chain.address, topics: [topic("Transfer(address,address,uint256)"), word(0n), `0x${from.slice(2).padStart(64, "0")}`, word(tokenId)], data: "0x" }] };
      }
      case "publish": {
        const [tokenId, mediaType, metadata, body] = args as [bigint, string, Uint8Array, Uint8Array];
        if (!holderOk(tokenId, from) || metadata.length + body.length > 350_000) return { ok: false, logs: [] };
        return published(tokenId, record(tokenId, { mediaType, metadata, body }));
      }
      case "publishSameBody": {
        const [tokenId, metadata, of] = args as [bigint, Uint8Array, number];
        if (!holderOk(tokenId, from) || !sameBodyOk(tokenId, Number(of))) return { ok: false, logs: [] };
        const ref = chain.records.get(tokenId)![Number(of)];
        return published(tokenId, record(tokenId, { mediaType: ref.mediaType, metadata, body: ref.body, bodyOf: Number(of) }));
      }
      case "begin": {
        const tokenId = args[0] as bigint;
        if (!holderOk(tokenId, from)) return { ok: false, logs: [] };
        const id = keccakHex(new TextEncoder().encode(`upload ${uploads.size} ${from}`));
        uploads.set(id, { tokenId, by: from, data: new Uint8Array(0) });
        return { ok: true, logs: [{ address: chain.address, topics: [topic("UploadBegun(uint256,bytes32,address)"), word(tokenId)], data: `${id}${from.slice(2).padStart(64, "0")}` }] };
      }
      case "append": {
        const u = uploads.get(toHex(args[0] as Uint8Array));
        const part = args[1] as Uint8Array;
        if (!u || u.by !== from || u.data.length + part.length > 350_000) return { ok: false, logs: [] };
        const next = new Uint8Array(u.data.length + part.length);
        next.set(u.data);
        next.set(part, u.data.length);
        u.data = next;
        return { ok: true, logs: [] };
      }
      case "commit":
      case "commitSameBody": {
        const id = toHex(args[0] as Uint8Array);
        const u = uploads.get(id);
        if (!u || u.by !== from || !holderOk(u.tokenId, from)) return { ok: false, logs: [] };
        uploads.delete(id);
        if (fn.name === "commit") {
          const [, mediaType, metadataLength] = args as [Uint8Array, string, number];
          if (Number(metadataLength) > u.data.length) return { ok: false, logs: [] };
          return published(u.tokenId, record(u.tokenId, { mediaType, metadata: u.data.slice(0, Number(metadataLength)), body: u.data.slice(Number(metadataLength)) }));
        }
        const of = Number(args[1]);
        if (!sameBodyOk(u.tokenId, of)) return { ok: false, logs: [] };
        const ref = chain.records.get(u.tokenId)![of];
        return published(u.tokenId, record(u.tokenId, { mediaType: ref.mediaType, metadata: u.data, body: ref.body, bodyOf: of }));
      }
    }
    return { ok: false, logs: [] };
  };
  return {
    address,
    sent,
    sendTransaction(tx) {
      const name = WRITES[tx.data.slice(0, 10)]?.name ?? "unknown";
      sent.push(name);
      chain.latest += 1;
      const { ok, logs } = execute(tx);
      const hash = keccakHex(new TextEncoder().encode(`${address} ${chain.chainId} ${n++} ${tx.data.slice(0, 74)}`));
      chain.receipts!.set(hash, { block: chain.latest, status: ok ? 1 : 0, logs });
      return Promise.resolve(hash);
    },
  };
}

/** Make everything mined so far final (P9.22). */
export function finalize(chain: FakeChain): void {
  chain.finalized = chain.latest;
}
