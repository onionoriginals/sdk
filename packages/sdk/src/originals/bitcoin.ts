/**
 * Bitcoin evidence for anchored Originals (plan 012; plan 011 PR 9a).
 *
 * `InscriptionClock` computes inscription times (P9.15): the greatest block
 * timestamp of a block and all its ancestors, so it never decreases along the
 * chain even when a block's own timestamp does. It follows reorganisations by
 * block hash, reads headers in batches when the source can, and can persist
 * what it derived through a `ClockStore` so a restart does not walk from
 * genesis again (#973). `satEvidence` turns a sat
 * snapshot from the SDK's sat reader into the evidence `verifyOriginal`
 * takes: one index's read, with the sat number and network that index
 * reports for each inscription (P9.10). A delegated or encoded inscription,
 * one the read did not ask for (`bodies: 'originals'`), or one past the
 * reader's byte budget, is passed on flagged `unsupported` and the verifier
 * ignores it with a reason (P9.12, P9.14). An Originals inscription the
 * reader did not read, unless the length or metadata the index reports
 * already rejects it (P9.17), or any publication whose body it could not
 * establish otherwise, fails the whole read: the anchoring sat
 * carries the Original's whole log, and a copy is no substitute (P9.17;
 * VH-Log PR 2).
 */
import { OriginalsError } from "@originals/vh";
import { ORIGINALS_INSCRIPTION_MAX_BYTES, ORIGINALS_INSCRIPTION_TYPE, type SatEvidence, type SatInscription } from "@originals/vh/originals";
import { hex } from "@scure/base";
import type { BitcoinNetwork, SatSnapshot } from "../bitcoin/sat-snapshot-types.js";
import { crc32 } from "./zip.js";

/** A block of the active chain: header timestamp in seconds, hash, and optionally its parent's hash. */
export interface BlockInfo {
  time: number;
  hash: string;
  /**
   * The parent block's hash (Core's `previousblockhash`). The clock checks
   * that each block it appends extends the one before it, so a
   * reorganisation during a read cannot splice two chains together. A
   * batched `headers` source must give it for every block but genesis
   * (`BLOCK_PARENT_REQUIRED`). Without it, a single-header source costs a
   * second request per new block: the clock re-reads the parent to check the
   * chain did not move. Give it.
   */
  prev?: string;
}

/** The block at a height on the active chain. */
export type BlockHeader = (height: number, signal?: AbortSignal) => Promise<BlockInfo>;

/**
 * Up to `count` consecutive blocks of the active chain from height `from`, in
 * order (one request: a JSON-RPC batch of `getblockhash`/`getblockheader`, or
 * a REST `/rest/headers/<count>/<hash>` read). Fewer may come back at the tip.
 */
export type BlockHeaders = (from: number, count: number, signal?: AbortSignal) => Promise<BlockInfo[]>;

/**
 * Where an `InscriptionClock` keeps what it derived across restarts. The
 * bytes are opaque and self-checking (network, block hashes, running maxima,
 * CRC-32); any key-value store, file or database blob will do. `load` returns
 * null when nothing was saved. `@originals/sdk/originals/fs` has a file store
 * for Node. The store is the reader's own derived state, not a checkpoint to
 * share: every hash in it was read from the reader's header source.
 * PROVISIONAL: the byte format ("OICK" version 1) and the clock's defaults.
 */
export interface ClockStore {
  load(): Promise<Uint8Array | null | undefined>;
  save(state: Uint8Array): Promise<void>;
}

export interface InscriptionClockOptions {
  /** The network the header source follows. Required with `store`; a saved state for another network is refused. */
  network?: BitcoinNetwork;
  /** A batched header source, used to append blocks `batch` at a time instead of one request per header. */
  headers?: BlockHeaders;
  /** Headers per batched request. Default 2000. */
  batch?: number;
  /** Persists the derived state; a restart resumes from it after checking it against the active chain. */
  store?: ClockStore;
  /** Save after this many newly derived blocks (and on `flush`). Default 144, about a day of blocks. */
  saveEvery?: number;
  /** Header requests one `at` call may make. Default 10,000; `Infinity` for none. */
  maxRequests?: number;
  /** Default cancellation (for example `AbortSignal.timeout(ms)`) for every `at` call. */
  signal?: AbortSignal;
}

export interface ClockReadOptions {
  signal?: AbortSignal;
  maxRequests?: number;
}

export interface ClockStats {
  /** Header-source requests made, single and batched. */
  requests: number;
  /** Headers received. */
  headers: number;
  /** Blocks whose running maximum the clock holds. */
  blocks: number;
  /** Blocks restored from the store when it was opened. */
  restored: number;
  /** Set when a saved state could not be used and the clock rebuilt instead. */
  discarded?: "corrupt";
}

const HASH = /^[0-9a-fA-F]{64}$/;
const NETWORKS: BitcoinNetwork[] = ["mainnet", "signet", "testnet", "regtest"];
const MAGIC = [0x4f, 0x49, 0x43, 0x4b]; // "OICK"
const FORMAT = 1;
const HEAD = 12;

interface Budget {
  left: number;
  limit: number;
  height: number;
  signal?: AbortSignal;
}

/**
 * Running maximum of block timestamps from genesis (P9.15). Every value is
 * derived from headers of the active chain; there are no built-in checkpoints.
 *
 * - Every read first checks the highest held block it relies on against the
 *   active chain and rewinds to the common ancestor if it moved (#971). A
 *   read of a block the clock holds therefore costs one request, and a block
 *   the chain has since orphaned is refused by hash (`BLOCK_NOT_ON_CHAIN`)
 *   as a fresh clock refuses it.
 * - Each appended block must extend the one before it: by its `prev`, or,
 *   from a single-header source without `prev`, by re-reading the parent.
 * - New blocks are appended `batch` at a time when a `headers` source is
 *   given; a warm read or a restart costs requests in proportion to new or
 *   reorganised blocks, not to the chain's height.
 * - Each `at` call has a request budget and an optional AbortSignal; running
 *   out is `incomplete-evidence`, never a guessed time, and what was derived
 *   so far is kept so a retry continues.
 * - With a `store`, a restart checks the saved network tag and genesis hash,
 *   then reconciles the saved boundary like any other read. A corrupt state
 *   is discarded and rebuilt; a foreign one fails loudly.
 */
export class InscriptionClock {
  private hashes: Uint8Array = new Uint8Array(32 * 1024);
  private maxima: Uint32Array = new Uint32Array(1024);
  private count = 0;
  private opened = false;
  private unsaved = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly counters = { requests: 0, headers: 0, restored: 0, discarded: undefined as ClockStats["discarded"] };
  private readonly options: InscriptionClockOptions;

  constructor(
    private readonly header: BlockHeader,
    options: InscriptionClockOptions = {},
  ) {
    if (options.store && !options.network) {
      throw new OriginalsError("invalid-evidence", "CLOCK_NETWORK_REQUIRED", "a clock with a store must name its Bitcoin network");
    }
    const batch = options.batch ?? 2000;
    if (!Number.isInteger(batch) || batch < 1) throw new OriginalsError("invalid-evidence", "CLOCK_OPTIONS_INVALID", `batch ${batch} is not a positive integer`);
    this.options = { ...options, batch };
  }

  get stats(): ClockStats {
    const { discarded, ...rest } = this.counters;
    return { ...rest, blocks: this.count, ...(discarded ? { discarded } : {}) };
  }

  /**
   * Inscription time at `height`, epoch milliseconds. Given the block's
   * `hash`, a block no longer on the active chain is refused
   * (`BLOCK_NOT_ON_CHAIN`). Without it, the time is for the block now at that
   * height.
   */
  async at(height: number, hash?: string, options: ClockReadOptions = {}): Promise<number> {
    if (!Number.isInteger(height) || height < 0) throw new OriginalsError("invalid-evidence", "BLOCK_HEIGHT_INVALID", `${height} is not a block height`);
    if (hash !== undefined && (typeof hash !== "string" || !HASH.test(hash))) {
      throw new OriginalsError("invalid-evidence", "BLOCK_HASH_INVALID", `${String(hash)} is not a block hash`);
    }
    return this.serialized(() => this.read(height, hash?.toLowerCase(), options));
  }

  /** Save the derived state now. A no-op without a store, or before the clock has read anything. */
  async flush(): Promise<void> {
    return this.serialized(() => (this.opened ? this.save() : Promise.resolve()));
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(height: number, hash: string | undefined, options: ClockReadOptions): Promise<number> {
    const limit = options.maxRequests ?? this.options.maxRequests ?? 10_000;
    const budget: Budget = { left: limit, limit, height, signal: options.signal ?? this.options.signal };
    let time: number;
    try {
      await this.open(budget);
      time = await this.derive(height, hash, budget);
    } catch (error) {
      // Keep what was derived, so a retry with a larger budget continues.
      if (this.unsaved >= (this.options.saveEvery ?? 144)) await this.save().catch(() => undefined);
      throw error;
    }
    if (this.unsaved >= (this.options.saveEvery ?? 144)) await this.save();
    return time;
  }

  private async derive(height: number, hash: string | undefined, budget: Budget): Promise<number> {
    // No shortcut for a held hash: the hash fixes the block's maximum, not
    // whether the active chain still has it, so it is probed like any read.
    for (;;) {
      if (this.count > 0) await this.reconcile(Math.min(height, this.count - 1), budget);
      if (await this.extend(height, budget)) break;
    }
    if (hash !== undefined && this.hashAt(height) !== hash) {
      throw new OriginalsError("invalid-evidence", "BLOCK_NOT_ON_CHAIN", `block ${hash} is not at height ${height} on the active chain`);
    }
    return this.maxima[height] * 1000;
  }

  /**
   * Keep the held blocks up to the highest at or below `top` that the active
   * chain still has: probe `top`, then gallop down and binary-search the fork
   * point, so a reorganisation `d` blocks deep costs O(log d) requests.
   */
  private async reconcile(top: number, budget: Budget): Promise<void> {
    const onChain = async (h: number) => (await this.fetch(h, budget)).hash.toLowerCase() === this.hashAt(h);
    if (await onChain(top)) return;
    let bad = top;
    let good = -1;
    for (let step = 1; ; step *= 2) {
      const h = Math.max(0, bad - step);
      if (await onChain(h)) {
        good = h;
        break;
      }
      bad = h;
      if (h === 0) {
        throw new OriginalsError("invalid-evidence", "BLOCK_SOURCE_NETWORK_MISMATCH", "the header source's genesis block changed: it follows another network");
      }
    }
    while (bad - good > 1) {
      const mid = Math.floor((good + bad) / 2);
      if (await onChain(mid)) good = mid;
      else bad = mid;
    }
    this.count = good + 1;
  }

  /** Append blocks up to `height`. False when a block does not extend the one before it: the chain moved mid-read. */
  private async extend(height: number, budget: Budget): Promise<boolean> {
    while (this.count <= height) {
      const want = Math.min(this.options.batch!, height - this.count + 1);
      const batched = !!this.options.headers && want > 1;
      const blocks = batched ? await this.fetchBatch(this.count, want, budget) : [await this.fetch(this.count, budget)];
      for (const block of blocks) {
        if (this.count > 0) {
          if (block.prev !== undefined) {
            if (block.prev.toLowerCase() !== this.hashAt(this.count - 1)) return false;
          } else if (batched) {
            // Blocks in one batch could come from two chains; only their parent links show it.
            throw new OriginalsError("invalid-evidence", "BLOCK_PARENT_REQUIRED", `the batched header source gave block ${this.count} without its parent's hash (prev)`);
          } else if ((await this.fetch(this.count - 1, budget)).hash.toLowerCase() !== this.hashAt(this.count - 1)) {
            // Its parent link was not given: the parent must still be the one held.
            return false;
          }
        }
        this.append(block);
      }
    }
    return true;
  }

  private append(block: BlockInfo): void {
    const h = this.count;
    if (h === this.maxima.length) {
      const maxima = new Uint32Array(h * 2);
      maxima.set(this.maxima);
      this.maxima = maxima;
      const hashes = new Uint8Array(h * 64);
      hashes.set(this.hashes);
      this.hashes = hashes;
    }
    this.hashes.set(hex.decode(block.hash.toLowerCase()), h * 32);
    this.maxima[h] = h === 0 ? block.time : Math.max(block.time, this.maxima[h - 1]);
    this.count++;
    this.unsaved++;
  }

  private hashAt(h: number): string {
    return hex.encode(this.hashes.subarray(h * 32, h * 32 + 32));
  }

  private aborted(budget: Budget): OriginalsError {
    return new OriginalsError("incomplete-evidence", "BLOCK_TIME_ABORTED", `the inscription time at height ${budget.height} was not established: the read was cancelled`, {
      height: budget.height,
      blocks: this.count,
    });
  }

  private spend(budget: Budget): void {
    if (budget.signal?.aborted) throw this.aborted(budget);
    if (budget.left <= 0) {
      throw new OriginalsError(
        "incomplete-evidence",
        "BLOCK_TIME_BUDGET_EXCEEDED",
        `the inscription time at height ${budget.height} needs more than ${budget.limit} header requests; ${this.count} blocks are established. ` +
          "Retry (progress is kept), raise maxRequests, give the clock a batched headers source, or persist it with a ClockStore",
        { height: budget.height, blocks: this.count, maxRequests: budget.limit },
      );
    }
    budget.left--;
    this.counters.requests++;
  }

  private async fetch(height: number, budget: Budget): Promise<BlockInfo> {
    this.spend(budget);
    const block = await this.call(() => this.header(height, budget.signal), budget);
    return this.checked(block, height);
  }

  private async fetchBatch(from: number, count: number, budget: Budget): Promise<BlockInfo[]> {
    this.spend(budget);
    const blocks = await this.call(() => this.options.headers!(from, count, budget.signal), budget);
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new OriginalsError("unavailable-bytes", "BLOCK_TIME_UNAVAILABLE", `no header for block ${from}`);
    }
    return blocks.slice(0, count).map((b, i) => this.checked(b, from + i));
  }

  private async call<T>(request: () => Promise<T>, budget: Budget): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw budget.signal?.aborted ? this.aborted(budget) : error;
    }
  }

  private checked(block: BlockInfo, height: number): BlockInfo {
    this.counters.headers++;
    if (
      !Number.isInteger(block?.time) || block.time < 0 || block.time > 0xffffffff ||
      typeof block.hash !== "string" || !HASH.test(block.hash) ||
      (block.prev !== undefined && (typeof block.prev !== "string" || !HASH.test(block.prev)))
    ) {
      throw new OriginalsError("unavailable-bytes", "BLOCK_TIME_UNAVAILABLE", `no header for block ${height}`);
    }
    return block;
  }

  /** Restore a saved state once, refusing one for another network or another chain's genesis. */
  private async open(budget: Budget): Promise<void> {
    if (this.opened) return;
    const { store, network } = this.options;
    if (store && network) {
      const bytes = await store.load();
      const state = bytes ? decodeClockState(bytes) : null;
      if (state === "corrupt") {
        this.counters.discarded = "corrupt";
      } else if (state) {
        if (state.network !== network) {
          throw new OriginalsError("invalid-evidence", "CLOCK_STORE_NETWORK_MISMATCH", `the saved clock follows ${state.network}, not ${network}`);
        }
        const genesis = hex.encode(state.hashes.subarray(0, 32));
        const actual = (await this.fetch(0, budget)).hash.toLowerCase();
        if (actual !== genesis) {
          throw new OriginalsError("invalid-evidence", "BLOCK_SOURCE_NETWORK_MISMATCH", `the header source's genesis ${actual} is not the saved clock's ${genesis}`);
        }
        this.hashes = state.hashes;
        this.maxima = state.maxima;
        this.count = state.count;
        this.counters.restored = state.count;
      }
    }
    this.opened = true;
  }

  private async save(): Promise<void> {
    const { store, network } = this.options;
    if (!store || !network || this.count === 0) return;
    await store.save(encodeClockState(network, this.count, this.hashes, this.maxima));
    this.unsaved = 0;
  }
}

function encodeClockState(network: BitcoinNetwork, count: number, hashes: Uint8Array, maxima: Uint32Array): Uint8Array {
  const out = new Uint8Array(HEAD + count * 36 + 4);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = FORMAT;
  out[5] = NETWORKS.indexOf(network);
  view.setUint32(8, count, true);
  out.set(hashes.subarray(0, count * 32), HEAD);
  const at = HEAD + count * 32;
  for (let h = 0; h < count; h++) view.setUint32(at + h * 4, maxima[h], true);
  view.setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)), true);
  return out;
}

function decodeClockState(bytes: Uint8Array): { network: BitcoinNetwork; count: number; hashes: Uint8Array; maxima: Uint32Array } | "corrupt" {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEAD + 4) return "corrupt";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  if (
    MAGIC.some((b, i) => bytes[i] !== b) || bytes[4] !== FORMAT || !NETWORKS[bytes[5]] || count === 0 ||
    bytes.length !== HEAD + count * 36 + 4 || view.getUint32(bytes.length - 4, true) !== crc32(bytes.subarray(0, bytes.length - 4))
  ) {
    return "corrupt";
  }
  const capacity = Math.max(1024, 2 ** Math.ceil(Math.log2(count + 1)));
  const hashes = new Uint8Array(capacity * 32);
  hashes.set(bytes.subarray(HEAD, HEAD + count * 32));
  const maxima = new Uint32Array(capacity);
  const at = HEAD + count * 32;
  for (let h = 0; h < count; h++) {
    maxima[h] = view.getUint32(at + h * 4, true);
    if (h > 0 && maxima[h] < maxima[h - 1]) return "corrupt"; // a running maximum never decreases (P9.15)
  }
  return { network: NETWORKS[bytes[5]], count, hashes, maxima };
}

const PREFIX: Record<BitcoinNetwork, string> = { mainnet: "", signet: "sig:", testnet: "test:", regtest: "reg:" };

/**
 * The did:btco alias of a sat on a network (plan 012 §3.5; P9.10, P14.12): the
 * prefixes are decided (owner decision, D6; spec PR #50 (open)), and proposed to
 * the did:btco method as decentralized-identity/labs-ordinals-plus#4 [S30].
 */
export function btcoAlias(network: BitcoinNetwork, sat: string): string {
  return `did:btco:${PREFIX[network]}${sat}`;
}

export interface SatEvidenceOptions {
  clock: InscriptionClock;
  /** Confirmations of the output now holding the sat; the adapter reports it (P9.11). */
  ownerConfirmations: number;
  /**
   * Which index served the snapshot, reported as used (P9.11). Pass one
   * `satEvidence` per index: the verifier compares their placement and
   * accepts nothing they disagree on (P9.10).
   */
  index: string;
  /** Cancels the clock's header reads. */
  signal?: AbortSignal;
}

/** The evidence `verifyOriginal` takes, from one sat snapshot. */
export async function satEvidence(snapshot: SatSnapshot, options: SatEvidenceOptions): Promise<SatEvidence> {
  if (!snapshot.enumerationComplete || !snapshot.indexHealthy) {
    throw new OriginalsError("unavailable-bytes", "SAT_READ_INCOMPLETE", `the sat ${snapshot.sat} was not read in full`);
  }
  const tip = snapshot.tipAfter;
  const inscriptions: SatInscription[] = [];
  // One clock read per block, however many inscriptions it holds.
  const times = new Map<string, Promise<number>>();
  const timeAt = (height: number, blockHash: string) => {
    const key = `${height}:${blockHash}`;
    let time = times.get(key);
    if (!time) times.set(key, (time = options.clock.at(height, blockHash, { signal: options.signal })));
    return time;
  };
  for (const p of snapshot.publications) {
    const body = p.body;
    // Observed but not read: a delegated or encoded body, one the read did not ask for, or one past the
    // read's byte budget (M1). An unread Originals inscription is missing evidence (P9.17), unless what
    // the index reports already rejects it: a body over 350,000 bytes, or metadata. Anything else is
    // flagged and the verifier ignores it with a reason, so the sat's holder cannot fail every read (P9.12).
    const unread = body.status === "unavailable" && "reason" in body;
    const rejectedUnread = unread && (body.contentLength > ORIGINALS_INSCRIPTION_MAX_BYTES || (body.reason === "over-budget" && body.metadataPresent === true));
    const observed = "reason" in body && body.reason !== undefined && !(unread && body.mediaType === ORIGINALS_INSCRIPTION_TYPE && !rejectedUnread);
    if ((body.status !== "complete" && !observed) || !p.creation) {
      throw new OriginalsError("unavailable-bytes", "SAT_READ_INCOMPLETE", `inscription ${p.id} on sat ${snapshot.sat} could not be read`);
    }
    const confirmations = p.confirmed ? tip.height - p.creation.height + 1 : 0;
    const content =
      body.status === "complete"
        ? { mediaType: body.mediaType, content: body.bytes, metadata: body.metadata }
        : {
            mediaType: ("mediaType" in body ? body.mediaType : null) ?? "application/octet-stream",
            content: new Uint8Array(),
            // A delegated or encoded inscription's own metadata, when read (null: it carries none).
            // Absent, it was not read: a did:btco history fails closed there (P5.13, PROVISIONAL).
            ...(!unread && "metadata" in body && body.metadata !== undefined ? { metadata: body.metadata } : {}),
            unsupported: unread ? ("not-read" as const) : (body as { reason: "delegated" | "content-encoding" }).reason,
            ...(unread ? { contentLength: body.contentLength } : {}),
            ...(unread && body.reason === "over-budget" && body.metadataPresent ? { metadataPresent: true } : {}),
          };
    inscriptions.push({
      id: p.id,
      // Where the index places it, not the sat the read was asked about (P9.10).
      sat: p.sat,
      network: p.network,
      height: p.creation.height,
      transactionIndex: p.creation.transactionIndex,
      inscriptionIndex: p.creation.inscriptionIndex,
      confirmations,
      inscriptionTime: await timeAt(p.creation.height, p.creation.blockHash),
      ...content,
    });
  }
  const satpoint = snapshot.ownership.satpoint;
  const output = satpoint ? satpoint.split(":").slice(0, 2).join(":") : null;
  if (typeof options.index !== "string" || options.index.length === 0) {
    throw new OriginalsError("invalid-evidence", "SAT_INDEX_REQUIRED", "name the index that served the sat read (P9.11)");
  }
  return {
    sat: btcoAlias(snapshot.network, snapshot.sat),
    index: options.index,
    tip: { height: tip.height, hash: tip.hash },
    inscriptions,
    owner: output
      ? { output, ...(snapshot.ownership.owner ? { address: snapshot.ownership.owner } : {}), confirmations: options.ownerConfirmations }
      : null,
  };
}
