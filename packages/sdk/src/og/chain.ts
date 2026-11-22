/**
 * Chain access for the did:og anchoring command. Transactions go through a
 * `ChainBackend`: mempool.space's Esplora API by default (mainnet, signet or
 * a URL you give), or Bitcoin Core's RPC on regtest. Inscriptions are read
 * from an ord 0.29.x explorer's JSON API (P9.31). No full node is needed on
 * mainnet or signet.
 */
import type { BitcoinNetwork } from "@originals/vh/og";

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  confirmations: number;
}

export interface ChainBackend {
  readonly name: string;
  utxos(address: string): Promise<Utxo[]>;
  txHex(txid: string): Promise<string>;
  /** Confirmations of a transaction: 0 in the mempool, null when the backend does not see it. */
  txConfirmations(txid: string): Promise<number | null>;
  broadcast(hex: string): Promise<string>;
  tip(): Promise<{ height: number; hash: string }>;
  /** The txids of a block, in order (the transaction index of chain order, P9.13). */
  blockTxids(height: number): Promise<string[]>;
  /** A fee rate in sat/vB for confirmation in about an hour. */
  feeRate(): Promise<number>;
}

export const MEMPOOL_SPACE: Readonly<Record<"mainnet" | "signet" | "testnet", string>> = {
  mainnet: "https://mempool.space/api",
  signet: "https://mempool.space/signet/api",
  testnet: "https://mempool.space/testnet4/api",
};

export const ORD_EXPLORER: Readonly<Partial<Record<BitcoinNetwork, string>>> = {
  mainnet: "https://ordinals.com",
  signet: "https://signet.ordinals.com",
  testnet: "https://testnet4.ordinals.com",
};

async function ok(r: Response, what: string): Promise<Response> {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}

/** Esplora, as mempool.space serves it. */
export class EsploraBackend implements ChainBackend {
  readonly name: string;
  constructor(private readonly base: string, private readonly fetcher: typeof fetch = fetch) {
    this.name = `esplora:${base}`;
  }
  private get = (path: string) => this.fetcher(`${this.base}${path}`).then((r) => ok(r, `GET ${path}`));
  async utxos(address: string): Promise<Utxo[]> {
    const [list, tip] = await Promise.all([this.get(`/address/${address}/utxo`).then((r) => r.json() as Promise<Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }>>), this.tip()]);
    return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmations: u.status.confirmed && u.status.block_height ? tip.height - u.status.block_height + 1 : 0 }));
  }
  txHex = (txid: string) => this.get(`/tx/${txid}/hex`).then((r) => r.text()).then((t) => t.trim());
  async txConfirmations(txid: string): Promise<number | null> {
    const r = await this.fetcher(`${this.base}/tx/${txid}/status`);
    if (r.status === 404) return null;
    const s = (await (await ok(r, "tx status")).json()) as { confirmed: boolean; block_height?: number };
    if (!s.confirmed) return 0;
    return (await this.tip()).height - s.block_height! + 1;
  }
  async broadcast(hex: string): Promise<string> {
    const r = await this.fetcher(`${this.base}/tx`, { method: "POST", body: hex, headers: { "content-type": "text/plain" } });
    return (await (await ok(r, "broadcast")).text()).trim();
  }
  async tip() {
    const height = Number(await this.get("/blocks/tip/height").then((r) => r.text()));
    const hash = (await this.get(`/block-height/${height}`).then((r) => r.text())).trim();
    return { height, hash };
  }
  async blockTxids(height: number): Promise<string[]> {
    const hash = (await this.get(`/block-height/${height}`).then((r) => r.text())).trim();
    return this.get(`/block/${hash}/txids`).then((r) => r.json() as Promise<string[]>);
  }
  async feeRate(): Promise<number> {
    const r = await this.fetcher(`${this.base.replace(/\/api$/, "/api/v1")}/fees/recommended`);
    if (r.ok) return ((await r.json()) as { hourFee: number }).hourFee;
    return ((await this.get("/fee-estimates").then((x) => x.json())) as Record<string, number>)["6"] ?? 2;
  }
}

/** Bitcoin Core's JSON-RPC, for regtest (txindex=1). */
export class CoreRpcBackend implements ChainBackend {
  readonly name: string;
  private id = 0;
  constructor(private readonly url: string, private readonly auth: string, private readonly fixedFeeRate = 2) {
    this.name = `core-rpc:${url}`;
  }
  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${btoa(this.auth)}` }, body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }) });
    const j = (await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }))) as { result: T; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  async utxos(address: string): Promise<Utxo[]> {
    const height = await this.rpc<number>("getblockcount");
    const scan = await this.rpc<{ unspents: Array<{ txid: string; vout: number; amount: number; height: number }> }>("scantxoutset", ["start", [`addr(${address})`]]);
    const confirmed = scan.unspents.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(Math.round(u.amount * 1e8)), confirmations: height - u.height + 1 }));
    return confirmed;
  }
  txHex = (txid: string) => this.rpc<string>("getrawtransaction", [txid, false]);
  async txConfirmations(txid: string): Promise<number | null> {
    try {
      const t = await this.rpc<{ confirmations?: number }>("getrawtransaction", [txid, true]);
      return t.confirmations ?? 0;
    } catch {
      return null;
    }
  }
  broadcast = (hex: string) => this.rpc<string>("sendrawtransaction", [hex]);
  async tip() {
    const height = await this.rpc<number>("getblockcount");
    return { height, hash: await this.rpc<string>("getblockhash", [height]) };
  }
  async blockTxids(height: number): Promise<string[]> {
    const hash = await this.rpc<string>("getblockhash", [height]);
    return (await this.rpc<{ tx: string[] }>("getblock", [hash, 1])).tx;
  }
  feeRate = () => Promise.resolve(this.fixedFeeRate);
}

/** An ord 0.29.x explorer's JSON API (P9.31). */
export class OrdExplorer {
  constructor(readonly base: string, private readonly fetcher: typeof fetch = fetch) {}
  private async json<T>(path: string): Promise<T> {
    const r = await ok(await this.fetcher(`${this.base}${path}`, { headers: { accept: "application/json" } }), `ord ${path}`);
    return r.json() as Promise<T>;
  }
  version = () => this.json<{ version?: string }>("/status").then((s) => s.version ?? "unknown").catch(() => "unknown");
  height = () => this.json<number>("/blockheight");
  async blockhash(height: number): Promise<string> {
    const r = await ok(await this.fetcher(`${this.base}/blockhash/${height}`), "ord blockhash");
    return (await r.text()).trim().replace(/^"|"$/g, "");
  }
  /** The first sat of an output (ord needs --index-sats). */
  async firstSat(outpoint: string): Promise<bigint> {
    const o = await this.json<{ sat_ranges?: Array<[number, number]> | null }>(`/output/${outpoint}`);
    if (!o.sat_ranges?.length) throw new Error(`ord reports no sat ranges for ${outpoint}: is it indexing sats, and has it reached that block?`);
    return BigInt(o.sat_ranges[0][0]);
  }
  output = (outpoint: string) => this.json<{ address?: string | null; sat_ranges?: Array<[number, number]> | null; inscriptions?: string[] }>(`/output/${outpoint}`);
  /** Every inscription on a sat, in ord's order. */
  async satInscriptions(sat: bigint | string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 0; ; page++) {
      const r = await this.json<{ ids: string[]; more: boolean }>(`/r/sat/${sat}/${page}`).catch(async () => ({ ids: (await this.json<{ inscriptions: string[] }>(`/sat/${sat}`)).inscriptions, more: false }));
      out.push(...r.ids);
      if (!r.more) return out;
    }
  }
  inscription = (id: string) => this.json<{ id: string; height: number; sat: number | null; satpoint: string; metaprotocol?: string | null; content_type?: string | null }>(`/inscription/${id}`);
}
