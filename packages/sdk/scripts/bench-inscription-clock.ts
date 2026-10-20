#!/usr/bin/env bun
/**
 * Cold-start, warm-read and process-restart benchmark for `InscriptionClock`
 * (#973) over a deterministic, mainnet-scale synthetic header chain.
 *
 *   bun packages/sdk/scripts/bench-inscription-clock.ts [--blocks 900000] [--batch 2000] [--rtt-ms 0] [--no-single]
 *
 * Header timestamps follow a 600 s trend with jitter, and every 101st block
 * steps back by over an hour, so many blocks have a timestamp earlier than an
 * ancestor's (P9.15). The header source is in-process; `--rtt-ms` adds a
 * delay per request to model a remote node. Request and header counts are the
 * stable result; latency depends on the machine. The unit test
 * `tests/unit/originals/clock-bench.test.ts` runs the same scenarios on a
 * smaller chain and asserts the counts.
 */
import { hex } from "@scure/base";
import { InscriptionClock, type BlockInfo, type ClockStore } from "../src/originals/bitcoin.js";

const GENESIS_TIME = 1231006505;

/** A deterministic chain of headers held compactly; it can grow and reorganise. */
export class SyntheticChain {
  times: Uint32Array;
  hashes: Uint8Array;
  length: number;
  /** Requests the chain served, single and batched, and headers returned. */
  served = { requests: 0, headers: 0 };
  private state: number;

  constructor(blocks: number, seed = 1, private readonly rttMs = 0) {
    this.state = seed >>> 0 || 1;
    const capacity = blocks + 4096;
    this.times = new Uint32Array(capacity);
    this.hashes = new Uint8Array(capacity * 32);
    this.length = 0;
    this.grow(blocks);
  }

  private random(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (this.state = x >>> 0);
  }

  private mint(h: number, skew = 0): void {
    for (let i = 0; i < 32; i += 4) new DataView(this.hashes.buffer).setUint32(h * 32 + i, this.random());
    const jitter = (this.random() % 1801) - 900;
    const back = h % 101 === 0 ? 4000 : 0;
    this.times[h] = Math.max(0, GENESIS_TIME + h * 600 + jitter - back - skew);
  }

  /** Append `n` blocks. */
  grow(n: number): void {
    for (let i = 0; i < n; i++) this.mint(this.length++);
  }

  /** Replace the top `depth` blocks with others whose timestamps are `skew` seconds earlier, then append `grow`. */
  reorg(depth: number, grow: number, skew = 1200): void {
    for (let h = this.length - depth; h < this.length; h++) this.mint(h, skew);
    this.grow(grow);
  }

  hash(h: number): string {
    return hex.encode(this.hashes.subarray(h * 32, h * 32 + 32));
  }

  /** Blocks whose own timestamp is earlier than their parent's. */
  decreasing(): number {
    let n = 0;
    for (let h = 1; h < this.length; h++) if (this.times[h] < this.times[h - 1]) n++;
    return n;
  }

  /** P9.15 by definition, independent of the clock: the greatest timestamp at or below `h`. */
  expected(h: number): number {
    let max = 0;
    for (let i = 0; i <= h; i++) max = Math.max(max, this.times[i]);
    return max * 1000;
  }

  private block(h: number): BlockInfo {
    return { time: this.times[h], hash: this.hash(h), ...(h > 0 ? { prev: this.hash(h - 1) } : {}) };
  }

  private async wait(): Promise<void> {
    if (this.rttMs > 0) await new Promise((resolve) => setTimeout(resolve, this.rttMs));
  }

  header = async (h: number): Promise<BlockInfo> => {
    this.served.requests++;
    await this.wait();
    if (h >= this.length) throw new Error(`no block ${h}`);
    this.served.headers++;
    return this.block(h);
  };

  headers = async (from: number, count: number): Promise<BlockInfo[]> => {
    this.served.requests++;
    await this.wait();
    const out: BlockInfo[] = [];
    for (let h = from; h < Math.min(this.length, from + count); h++) out.push(this.block(h));
    this.served.headers += out.length;
    return out;
  };
}

/** A store in memory: what a key-value or blob store would hold. */
export function memoryClockStore(): ClockStore & { bytes: Uint8Array | null } {
  const store = {
    bytes: null as Uint8Array | null,
    load: () => Promise.resolve(store.bytes),
    save: (state: Uint8Array) => Promise.resolve(void (store.bytes = state)),
  };
  return store;
}

export interface BenchRow {
  scenario: string;
  requests: number;
  headers: number;
  ms: number;
  note?: string;
}

export interface BenchOptions {
  blocks: number;
  batch?: number;
  rttMs?: number;
  /** Also run a cold start with only the single-header source. */
  single?: boolean;
  /** The store a "process" uses; each restart calls this again for the same place. */
  store?: () => ClockStore;
  log?: (row: BenchRow) => void;
}

/** Run the scenarios. Throws if any cached time differs from an independent rebuild. */
export async function runBenchmark(options: BenchOptions): Promise<{ rows: BenchRow[]; chain: SyntheticChain; stateBytes: number }> {
  const batch = options.batch ?? 2000;
  const chain = new SyntheticChain(options.blocks, 7, options.rttMs ?? 0);
  const shared = memoryClockStore();
  const storeFor = options.store ?? (() => shared);
  const rows: BenchRow[] = [];
  const process = () =>
    new InscriptionClock(chain.header, { network: "mainnet", headers: chain.headers, batch, store: storeFor(), maxRequests: Infinity });
  const measure = async (scenario: string, work: () => Promise<unknown>, note?: string) => {
    const before = { ...chain.served };
    const start = performance.now();
    await work();
    const row: BenchRow = {
      scenario,
      requests: chain.served.requests - before.requests,
      headers: chain.served.headers - before.headers,
      ms: Math.round((performance.now() - start) * 10) / 10,
      ...(note ? { note } : {}),
    };
    rows.push(row);
    options.log?.(row);
    return row;
  };
  const check = async (clock: InscriptionClock, h: number) => {
    const got = await clock.at(h, chain.hash(h));
    if (got !== (await reference.at(h, chain.hash(h)))) throw new Error(`the cached clock's time at ${h} differs from a rebuilt clock's`);
  };
  let reference = new InscriptionClock(chain.header, { headers: chain.headers, batch, maxRequests: Infinity });

  // 1. Cold start: the first read near the tip derives every block.
  let tip = chain.length - 1;
  let clock = process();
  await measure("cold start, batched", () => clock.at(tip, chain.hash(tip)), `${chain.length} headers, batch ${batch}`);
  let stateBytes = 0;
  await measure("save state", async () => {
    await clock.flush();
    stateBytes = shared.bytes?.length ?? 0;
  }, options.store ? "file store" : "memory store");

  // 2. Warm reads: known blocks cost nothing; a new block costs a boundary check and one batch.
  const sample = Array.from({ length: 10_000 }, (_, i) => Math.floor((i * 2654435761) % chain.length));
  await measure("warm read x10,000, known blocks", async () => {
    for (const h of sample) await clock.at(h, chain.hash(h));
  });
  chain.grow(1);
  tip = chain.length - 1;
  await measure("warm read, 1 new block", () => clock.at(tip, chain.hash(tip)));
  await clock.flush();

  // 3. Process restart: a new clock restores the saved state.
  clock = process();
  const known = sample[0];
  await measure("restart, read a known block", () => clock.at(known, chain.hash(known)), "includes loading and checking the state");
  chain.grow(6);
  tip = chain.length - 1;
  await measure("restart, then 6 new blocks", () => clock.at(tip, chain.hash(tip)));
  await clock.flush();

  // 4. Restart after a reorganisation across the saved boundary.
  chain.reorg(6, 3);
  tip = chain.length - 1;
  clock = process();
  await measure("restart across a 6-block reorg (+3)", () => clock.at(tip, chain.hash(tip)), "rewinds to the fork point");

  // 5. An independently rebuilt clock agrees at sampled heights and around the fork.
  reference = new InscriptionClock(chain.header, { headers: chain.headers, batch, maxRequests: Infinity });
  await measure("independent rebuild", () => reference.at(tip, chain.hash(tip)));
  for (const h of [...sample.slice(0, 1000), ...Array.from({ length: 12 }, (_, i) => tip - i)]) await check(clock, h);

  if (options.single) {
    const single = new InscriptionClock(chain.header, { maxRequests: Infinity });
    await measure("cold start, one request per header", () => single.at(tip, chain.hash(tip)));
    const bounded = new InscriptionClock(chain.header);
    await measure("cold start, default budget", async () => {
      await bounded.at(tip, chain.hash(tip)).catch((e: { code?: string }) => {
        if (e.code !== "BLOCK_TIME_BUDGET_EXCEEDED") throw e;
      });
    }, `refused with BLOCK_TIME_BUDGET_EXCEEDED after ${10_000} requests; progress kept`);
  }
  return { rows, chain, stateBytes };
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(process.argv[i + 1]);
}

if (import.meta.main) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileClockStore } = await import("../src/originals/fs-store.js");
  const dir = mkdtempSync(join(tmpdir(), "inscription-clock-"));
  const blocks = arg("blocks", 900_000);
  const batch = arg("batch", 2000);
  const rttMs = arg("rtt-ms", 0);
  try {
    const started = performance.now();
    console.log(`InscriptionClock benchmark: ${blocks} synthetic headers, batch ${batch}, ${rttMs} ms per request, Bun ${Bun.version} ${process.platform}/${process.arch}`);
    const { chain, stateBytes } = await runBenchmark({
      blocks,
      batch,
      rttMs,
      single: !process.argv.includes("--no-single"),
      store: () => fileClockStore(join(dir, "clock.bin")),
      log: (r) => console.log(`${r.scenario.padEnd(40)} requests ${String(r.requests).padStart(7)}  headers ${String(r.headers).padStart(7)}  ${String(r.ms).padStart(9)} ms${r.note ? `  (${r.note})` : ""}`),
    });
    const { statSync } = await import("node:fs");
    console.log(`decreasing timestamps: ${chain.decreasing()}; state file: ${statSync(join(dir, "clock.bin")).size || stateBytes} bytes; cached and rebuilt clocks agree; total ${Math.round(performance.now() - started)} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
