import type { BitcoinNetwork, SatSnapshot } from '../../bitcoin/sat-snapshot-types.js';
import { MAX_SATOSHI_SUPPLY } from '../../utils/satoshi-validation.js';
import { OriginalsError } from '@originals/vh';
import { ORIGINALS_INSCRIPTION_MAX_BYTES, ORIGINALS_INSCRIPTION_TYPE } from '@originals/vh/originals';
import { ResponseTooLargeError } from '../response-body-limit.js';

/** Transport seam for ord's complete /sat, /inscription and raw /r/metadata views. */
export interface SatSnapshotReader {
  rpc(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown>;
  status(signal?: AbortSignal): Promise<unknown>;
  indexHash(height: number, signal?: AbortSignal): Promise<unknown>;
  sat(satoshi: string, signal?: AbortSignal): Promise<unknown>;
  inscription(id: string, signal?: AbortSignal): Promise<unknown>;
  content(id: string, signal?: AbortSignal): Promise<Uint8Array | null>;
  metadata(id: string, signal?: AbortSignal): Promise<unknown>;
}

export interface SatSnapshotBudget {
  /**
   * Total time for one complete observation, including stalled reads. By
   * default it scales with the inscriptions the index lists: 30 seconds plus
   * 250 ms per inscription, at most `maxTimeoutMs`, so the holder of a sat
   * cannot make every read of it fail by reinscribing it (P9.12). An explicit
   * value is kept as given (at most one hour). PROVISIONAL.
   */
  timeoutMs?: number;
  /** Bound on the scaled default `timeoutMs` (default 10 minutes, at most one hour). */
  maxTimeoutMs?: number;
  /** Time for each upstream request (default 15 seconds, at most 10 minutes). A request past it fails the read (`SAT_SNAPSHOT_REQUEST_TIMEOUT`). */
  requestTimeoutMs?: number;
  /** Inscription, body and metadata reads in flight at once (default 8, at most 64). */
  concurrency?: number;
  /**
   * Total upstream requests for one observation. By default the budget
   * scales with the inscriptions the index lists: 7 + 5 per inscription
   * (`/inscription`, at most two Core block reads, body and metadata), so a
   * sat with many entries is read in full; `maxListedInscriptions` bounds it.
   * An explicit value is kept as given (at most 1,000,000). No partial result
   * is returned.
   */
  maxRequests?: number;
  /**
   * Inscriptions whose body and metadata one observation reads (default
   * 10,000, at most 100,000), in listing order; with `bodies: 'originals'`
   * only the Originals inscriptions it would read count. Past it the sat is
   * still enumerated and each inscription's index record read, but its body
   * and metadata are not: it is reported observed but unread (`{ status:
   * 'unavailable', reason: 'over-budget' }`), so the holder of a sat, who has
   * no authority over it (P9.12), cannot make every read of it fail by
   * reinscribing it. Whether an unread one matters is the consumer's call:
   * `satEvidence` fails closed on an unread Originals inscription (P9.17).
   * PROVISIONAL.
   */
  maxInscriptions?: number;
  /**
   * Inscriptions a sat may list before the read is refused
   * (`SAT_SNAPSHOT_TOO_MANY_INSCRIPTIONS`; default 100,000, at most
   * 1,000,000). Each listed one costs an index record and, at most, two block
   * reads, within `maxRequests` and `timeoutMs`. PROVISIONAL.
   */
  maxListedInscriptions?: number;
  /**
   * Body and metadata bytes read in one observation (default 32 MiB, at most
   * 512 MiB), for every inscription except Originals inscriptions within
   * their size limit, which `maxOriginalsBytes` bounds. A body or metadata
   * that would pass it, or that passes the transport's response cap, is
   * reported observed but unread (`{ status: 'unavailable', reason:
   * 'over-budget' }`) and the read goes on.
   */
  maxContentBytes?: number;
  /**
   * Body and metadata bytes of `application/vnd.originals.vh+jsonl`
   * inscriptions of at most 350,000 bytes (P9.17) read in one observation
   * (default 64 MiB, at most 1 GiB). Kept apart from `maxContentBytes`, so
   * other bodies on the sat cannot spend what an Originals entry is read
   * from. PROVISIONAL.
   *
   * PROVISIONAL bound (#966 r5, finding 2): Originals-typed inscriptions
   * the holder adds are read from this pool too, because an unread one could
   * be an entry (P9.17), so `satEvidence` fails closed on them. About 192
   * Originals-typed inscriptions of 350,000 bytes (some 67 MB of witness
   * data) exhaust the default, and more than `maxInscriptions` (10,000)
   * Originals-typed inscriptions of any size exhaust that; either makes a
   * default read an explicit incomplete result (`SAT_READ_INCOMPLETE`), never a
   * wrong one. A reader raises them (up to 1 GiB and 100,000) to read on.
   */
  maxOriginalsBytes?: number;
}

/** What a read fetches besides the sat's enumeration. */
export interface SatSnapshotOptions {
  /**
   * `all` (default) reads every inscription's body and metadata: a did:btco
   * read needs the metadata its versions live in (P5.13). `originals` reads
   * only the bodies and metadata of `application/vnd.originals.vh+jsonl`
   * inscriptions of at most 350,000 bytes: an Original's asset read needs
   * nothing else (P9.17), so other bodies on the sat cost no time or budget.
   * The rest are reported observed but unread (`not-requested`,
   * `over-budget`). PROVISIONAL.
   */
  bodies?: 'all' | 'originals';
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const chains: Record<string, BitcoinNetwork> = { main: 'mainnet', mainnet: 'mainnet', test: 'testnet', testnet: 'testnet', testnet3: 'testnet', testnet4: 'testnet', signet: 'signet', regtest: 'regtest' };
const networkOf = (value: unknown): BitcoinNetwork | undefined => typeof value === 'string' && Object.prototype.hasOwnProperty.call(chains, value) ? chains[value] : undefined;
/** Malformed or inconsistent upstream answers (section 6). */
const invalid = (code: string, message: string) => new OriginalsError('invalid-evidence', code, message);
/** Answers that are missing or not yet stable: an explicit incomplete result (section 6). */
const incomplete = (code: string, message: string, details?: Record<string, unknown>) => new OriginalsError('incomplete-evidence', code, message, details);
const within = (value: number | undefined, fallback: number, max: number, allowZero = false) =>
  value === undefined ? fallback : Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) && value <= max ? value : NaN;
/** Requests besides the per-inscription reads: two Core tips, two index statuses and hashes, and /sat. */
const FIXED_REQUESTS = 7;
const PER_INSCRIPTION = 5;
const BASE_TIMEOUT_MS = 30_000;
const PER_INSCRIPTION_MS = 250;

/** A hex nibble's value, or -1. */
const nibble = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);
/** Decode hex without a regular expression: a pattern over a multi-megabyte string fails on some engines (Bun). */
function decodeHex(text: string): Uint8Array | undefined {
  if (text.length % 2 !== 0) return undefined;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = nibble(text.charCodeAt(2 * i)), lo = nibble(text.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) return undefined;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Run `work` over `items` with at most `limit` in flight, results in order; the first failure stops the rest. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>, failed: (error: unknown) => void): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        out[i] = await work(items[i]);
      } catch (error) {
        if (!failure) { failure = { error }; failed(error); }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return out;
}

/**
 * One complete, stable sat observation: no decoded metadata, no delegated or
 * encoded bytes taken as a body, no moving index. Delegated and encoded
 * inscriptions (with their own metadata, read where a did:btco read needs it:
 * `bodies: 'all'`), bodies the caller did not ask for (`options.bodies`), and
 * bodies or metadata past the byte budget or the transport's response cap,
 * are reported observed but unread instead of failing the read, and the
 * time budget scales with the inscriptions listed, so the holder of a sat
 * cannot make every read of it fail (P9.12). Every failure is an
 * `OriginalsError` with a section 6 category.
 */
export async function readSatSnapshot(reader: SatSnapshotReader, satoshi: string, expectedNetwork?: BitcoinNetwork, budget: SatSnapshotBudget = {}, options: SatSnapshotOptions = {}): Promise<SatSnapshot> {
  const explicitTimeout = within(budget.timeoutMs, BASE_TIMEOUT_MS, 3_600_000);
  const maxTimeoutMs = within(budget.maxTimeoutMs, 600_000, 3_600_000);
  const requestTimeoutMs = within(budget.requestTimeoutMs, 15_000, 600_000);
  const concurrency = within(budget.concurrency, 8, 64);
  const explicitRequests = within(budget.maxRequests, 0, 1_000_000);
  const maxInscriptions = within(budget.maxInscriptions, 10_000, 100_000, true);
  const maxListedInscriptions = within(budget.maxListedInscriptions, 100_000, 1_000_000, true);
  const maxContentBytes = within(budget.maxContentBytes, 32 * 1024 * 1024, 512 * 1024 * 1024, true);
  const maxOriginalsBytes = within(budget.maxOriginalsBytes, 64 * 1024 * 1024, 1024 * 1024 * 1024, true);
  const bodies = options.bodies ?? 'all';
  if ([explicitTimeout, maxTimeoutMs, requestTimeoutMs, concurrency, explicitRequests, maxInscriptions, maxListedInscriptions, maxContentBytes, maxOriginalsBytes].some(Number.isNaN) ||
      (bodies !== 'all' && bodies !== 'originals')) {
    throw invalid('SAT_SNAPSHOT_BUDGET_INVALID', 'Invalid sat snapshot budget');
  }
  let timeoutMs = budget.timeoutMs !== undefined ? explicitTimeout : Math.min(BASE_TIMEOUT_MS, maxTimeoutMs);
  // Until the index lists the sat's inscriptions, only the fixed reads are allowed.
  let maxRequests = budget.maxRequests !== undefined ? explicitRequests : FIXED_REQUESTS;
  const exhausted = () => incomplete('SAT_SNAPSHOT_BUDGET_EXCEEDED', 'Complete sat observation exceeded its total request or time budget', { maxRequests, timeoutMs });
  const controller = new AbortController();
  const started = performance.now();
  let timer = setTimeout(() => controller.abort(exhausted()), timeoutMs);
  let requests = 0;
  const call = async <T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (requests >= maxRequests || performance.now() >= started + timeoutMs) controller.abort(exhausted());
    controller.signal.throwIfAborted();
    requests++;
    const request = new AbortController();
    const timeout = setTimeout(() => request.abort(incomplete('SAT_SNAPSHOT_REQUEST_TIMEOUT', `An upstream request took longer than ${requestTimeoutMs} ms`, { requestTimeoutMs })), requestTimeoutMs);
    const signal = AbortSignal.any([controller.signal, request.signal]);
    // Race also bounds a transport that ignores cancellation. Its completion
    // cannot resume the scan; compliant transports abort their in-flight read.
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : exhausted());
        signal.addEventListener('abort', onAbort, { once: true });
      }), read(signal)]);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  };
  try {
    return await collectSatSnapshot({
      rpc: (method, params) => call(signal => reader.rpc(method, params, signal)),
      status: () => call(signal => reader.status(signal)),
      indexHash: height => call(signal => reader.indexHash(height, signal)),
      sat: sat => call(signal => reader.sat(sat, signal)),
      inscription: id => call(signal => reader.inscription(id, signal)),
      content: id => call(signal => reader.content(id, signal)),
      metadata: id => call(signal => reader.metadata(id, signal)),
    }, satoshi, expectedNetwork, {
      maxInscriptions,
      maxListedInscriptions,
      maxContentBytes,
      maxOriginalsBytes,
      concurrency,
      bodies,
      fail: error => controller.abort(error),
      listed: count => {
        if (budget.maxRequests === undefined) maxRequests = FIXED_REQUESTS + PER_INSCRIPTION * count;
        if (budget.timeoutMs === undefined) {
          timeoutMs = Math.min(BASE_TIMEOUT_MS + PER_INSCRIPTION_MS * count, maxTimeoutMs);
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(exhausted()), Math.max(0, started + timeoutMs - performance.now()));
        }
      },
    });
  } finally { clearTimeout(timer); }
}

interface Limits {
  maxInscriptions: number;
  maxListedInscriptions: number;
  maxContentBytes: number;
  maxOriginalsBytes: number;
  concurrency: number;
  bodies: 'all' | 'originals';
  /** Stops the reads still in flight after one fails. */
  fail: (error: unknown) => void;
  /** Called once the index has listed the sat's inscriptions. */
  listed(count: number): void;
}

/** A transport's response cap was passed: the item is observed but unread, not a failed read. */
const tooLarge = (error: unknown) => error instanceof ResponseTooLargeError;

async function collectSatSnapshot(reader: SatSnapshotReader, satoshi: string, expectedNetwork: BitcoinNetwork | undefined, limits: Limits): Promise<SatSnapshot> {
  // Canonical decimal sat number within supply: no leading zeros, sign or whitespace.
  if (!/^(0|[1-9]\d{0,15})$/.test(satoshi) || BigInt(satoshi) > BigInt(MAX_SATOSHI_SUPPLY)) {
    throw invalid('INVALID_SATOSHI', 'Invalid canonical sat number');
  }
  const readTip = async () => {
    const info = object(await reader.rpc('getblockchaininfo', []));
    const network = networkOf(info.chain);
    if (!network || (expectedNetwork && network !== expectedNetwork)) throw invalid('SAT_SNAPSHOT_NETWORK_MISMATCH', 'Snapshot Bitcoin network mismatch');
    if (!integer(info.blocks) || !hash(info.bestblockhash)) throw incomplete('SAT_SNAPSHOT_TIP_UNAVAILABLE', 'Core chain tip unavailable');
    return { network, height: info.blocks, hash: info.bestblockhash };
  };
  const before = await readTip();
  const readIndex = async () => {
    const status = object(await reader.status());
    // /sat derives ownership from the current output. The address index is
    // needed for the inverse address-to-outputs lookup, which this scan never uses.
    if (networkOf(status.chain) !== before.network || !integer(status.height) || status.sat_index !== true ||
        status.inscription_index !== true || status.unrecoverably_reorged !== false)
      throw incomplete('SAT_SNAPSHOT_INDEX_UNHEALTHY', 'Healthy ord sat and inscription indexes required');
    const indexedHash = await reader.indexHash(status.height);
    if (!hash(indexedHash)) throw incomplete('SAT_SNAPSHOT_INDEX_UNHEALTHY', 'ord index hash unavailable');
    if (status.height !== before.height || indexedHash !== before.hash) throw incomplete('SAT_SNAPSHOT_CHAIN_CHANGED', 'ord index is not at the stable Core tip');
    return { height: status.height, hash: indexedHash };
  };
  const indexTip = await readIndex();
  const sat = object(await reader.sat(satoshi));
  if (!integer(sat.number) || String(sat.number) !== satoshi || !Array.isArray(sat.inscriptions) ||
      !(sat.address === null || typeof sat.address === 'string') || !(sat.satpoint === null || typeof sat.satpoint === 'string'))
    throw incomplete('SAT_SNAPSHOT_ENUMERATION_UNAVAILABLE', 'Complete sat enumeration and ownership required');
  // Only the enumeration is refused outright; past maxInscriptions bodies are left unread (#966 r5, finding 1).
  if (sat.inscriptions.length > limits.maxListedInscriptions) {
    throw incomplete('SAT_SNAPSHOT_TOO_MANY_INSCRIPTIONS', `The sat lists ${sat.inscriptions.length} inscriptions, more than maxListedInscriptions ${limits.maxListedInscriptions}`,
      { inscriptions: sat.inscriptions.length, maxListedInscriptions: limits.maxListedInscriptions });
  }
  limits.listed(sat.inscriptions.length);
  const ids: Array<{ id: string; txid: string; index: number }> = [];
  const seen = new Set<string>();
  for (const id of sat.inscriptions) {
    if (typeof id !== 'string' || !/^([0-9a-f]{64})i(0|[1-9]\d*)$/.test(id) || seen.has(id)) throw invalid('SAT_SNAPSHOT_INSCRIPTION_ID', 'Invalid or duplicate inscription id');
    seen.add(id);
    const [txid, index] = id.split('i');
    if (!integer(Number(index))) throw invalid('SAT_SNAPSHOT_INSCRIPTION_ID', 'Invalid inscription index');
    ids.push({ id, txid, index: Number(index) });
  }

  // 1. Each listed inscription and its active block, a bounded number at a time.
  const blocks = new Map<number, Promise<SatSnapshot['blocks'][number]>>();
  const readBlock = (height: number) => {
    let block = blocks.get(height);
    if (!block) {
      block = (async () => {
        const blockHash = await reader.rpc('getblockhash', [height]);
        if (!hash(blockHash)) throw incomplete('SAT_SNAPSHOT_BLOCK_UNAVAILABLE', 'Active block hash unavailable');
        const observed = object(await reader.rpc('getblock', [blockHash, 1]));
        if (observed.hash !== blockHash || observed.height !== height || !integer(observed.confirmations) || observed.confirmations < 1 ||
            !Array.isArray(observed.tx) || !observed.tx.length || !observed.tx.every(hash) || new Set(observed.tx).size !== observed.tx.length)
          throw incomplete('SAT_SNAPSHOT_BLOCK_UNAVAILABLE', 'Active block observation unavailable');
        if (!integer(observed.time)) throw incomplete('SAT_SNAPSHOT_BLOCK_UNAVAILABLE', 'Active block timestamp unavailable');
        return { height, hash: blockHash, txids: observed.tx, time: observed.time };
      })();
      block.catch(() => undefined);
      blocks.set(height, block);
    }
    return block;
  };
  const listed = await pool(ids, limits.concurrency, async ({ id, txid, index }) => {
    const info = object(await reader.inscription(id));
    if (info.id !== id || !integer(info.sat) || String(info.sat) !== satoshi || !integer(info.height) || info.height > before.height)
      throw incomplete('SAT_SNAPSHOT_INSCRIPTION_UNAVAILABLE', 'Listed inscription observation unavailable');
    if (!(info.content_type === null || typeof info.content_type === 'string') || !(info.content_length === null || integer(info.content_length)))
      throw incomplete('SAT_SNAPSHOT_INSCRIPTION_UNAVAILABLE', 'Explicit inscription content type and length required');
    const block = await readBlock(info.height);
    const transactionIndex = block.txids.indexOf(txid);
    if (transactionIndex < 0) throw invalid('SAT_SNAPSHOT_REVEAL_NOT_IN_BLOCK', 'Listed reveal is absent from its active block');
    const observation = { id, revealTxid: txid, network: before.network, sat: satoshi, confirmed: true,
      creation: { height: info.height, blockHash: block.hash, transactionIndex, inscriptionIndex: index } };
    return { observation, info, mediaType: info.content_type, length: info.content_length ?? 0 };
  }, error => limits.fail(error));

  // 2. Which bodies to read, decided in listing order before any is read.
  type Publication = SatSnapshot['publications'][number];
  const used = { originals: 0, other: 0 };
  let reads = 0;
  const cap = { originals: limits.maxOriginalsBytes, other: limits.maxContentBytes };
  const plan = listed.map(({ observation, info, mediaType, length }) => {
    const unread = (body: Publication['body']): { publication: Publication } => ({ publication: { ...observation, body } });
    // Observed, never taken as its own body: ord would serve another inscription's bytes, or encoded ones (P9.14).
    // Its own metadata is unaffected; a full read (`bodies: 'all'`, as did:btco reads use) reads it, since on a
    // did:btco sat it could be a version (P5.13, PROVISIONAL). Not read, it is left absent, never taken as none.
    if (info.delegate != null || info.content_encoding != null) {
      const reason = info.delegate != null ? 'delegated' as const : 'content-encoding' as const;
      if (limits.bodies === 'originals') return unread({ status: 'unsupported', reason, mediaType });
      return { metadataOf: { observation, mediaType, reason } };
    }
    const originals = mediaType === ORIGINALS_INSCRIPTION_TYPE && length <= ORIGINALS_INSCRIPTION_MAX_BYTES;
    if (limits.bodies === 'originals' && !originals) {
      // An Originals-typed body over the limit is rejected by its length alone (P9.17).
      return unread(mediaType === ORIGINALS_INSCRIPTION_TYPE
        ? { status: 'unavailable', reason: 'over-budget', mediaType, contentLength: length }
        : { status: 'unavailable', reason: 'not-requested', mediaType, contentLength: length });
    }
    const pool = originals ? 'originals' as const : 'other' as const;
    // Past maxInscriptions reads, or the byte budget: observed but unread (P9.12). The consumer decides
    // whether it could matter: satEvidence fails closed on an unread Originals inscription (P9.17).
    if (reads >= limits.maxInscriptions || used[pool] + length > cap[pool]) return unread({ status: 'unavailable', reason: 'over-budget', mediaType, contentLength: length });
    reads++;
    used[pool] += length;
    return { read: { observation, info, mediaType, length, pool } };
  });

  // 3. The chosen bodies and their metadata, a bounded number at a time.
  const readMetadata = async (id: string): Promise<{ metadataHex: string | null } | { metadataTooLarge: true }> => {
    let metadataHex: unknown;
    try {
      metadataHex = await reader.metadata(id);
    } catch (error) {
      if (tooLarge(error)) return { metadataTooLarge: true };
      throw error;
    }
    if (metadataHex !== null && typeof metadataHex !== 'string') throw incomplete('SAT_SNAPSHOT_METADATA_UNAVAILABLE', 'Raw metadata bytes unavailable');
    return { metadataHex };
  };
  const fetched = await pool(plan, limits.concurrency, async (step) => {
    if ('metadataOf' in step && step.metadataOf) return readMetadata(step.metadataOf.observation.id);
    if (!('read' in step)) return undefined;
    const { observation: { id }, info, length } = step.read;
    let content: Uint8Array | null;
    try {
      content = await reader.content(id);
    } catch (error) {
      if (tooLarge(error)) return { bodyTooLarge: true as const };
      throw error;
    }
    // Null explicitly reports a bodyless inscription. Never accept delegated/effective bytes as its own body.
    if ((content === null && info.content_length !== null) || (content?.length ?? 0) !== length)
      throw incomplete('SAT_SNAPSHOT_CONTENT_UNAVAILABLE', 'Listed inscription content is unavailable or has a different byte length');
    return { content, ...(await readMetadata(id)) };
  }, error => limits.fail(error));

  // 4. Metadata, whose length the index does not report beforehand, counted in listing order.
  const publications: SatSnapshot['publications'] = plan.map((step, k) => {
    if ('metadataOf' in step && step.metadataOf) {
      // A delegated or encoded inscription's own metadata, from the other bodies' budget; past it, left absent (not read).
      const { observation, mediaType, reason } = step.metadataOf;
      const got = fetched[k] as { metadataHex: string | null } | { metadataTooLarge: true };
      const unsupported = (metadata?: Uint8Array | null): Publication =>
        ({ ...observation, body: { status: 'unsupported', reason, mediaType, ...(metadata !== undefined ? { metadata } : {}) } });
      if ('metadataTooLarge' in got) return unsupported();
      if (got.metadataHex === null) return unsupported(null);
      if (used.other + got.metadataHex.length / 2 > cap.other) return unsupported();
      const decoded = decodeHex(got.metadataHex);
      if (!decoded) throw incomplete('SAT_SNAPSHOT_METADATA_UNAVAILABLE', 'Raw metadata bytes unavailable');
      used.other += decoded.length;
      return unsupported(decoded);
    }
    if (!('read' in step)) return step.publication;
    const { observation, mediaType, length, pool } = step.read;
    const got = fetched[k] as { bodyTooLarge: true } | { content: Uint8Array | null; metadataTooLarge: true } | { content: Uint8Array | null; metadataHex: string | null };
    const over = (metadataPresent: boolean): Publication =>
      ({ ...observation, body: { status: 'unavailable', reason: 'over-budget', mediaType, contentLength: length, ...(metadataPresent ? { metadataPresent: true as const } : {}) } });
    if ('bodyTooLarge' in got) return over(false);
    if ('metadataTooLarge' in got) return over(true);
    let metadata: Uint8Array | null = null;
    if (got.metadataHex !== null) {
      if (used[pool] + got.metadataHex.length / 2 > cap[pool]) return over(true);
      const decoded = decodeHex(got.metadataHex);
      if (!decoded) throw incomplete('SAT_SNAPSHOT_METADATA_UNAVAILABLE', 'Raw metadata bytes unavailable');
      used[pool] += decoded.length;
      metadata = decoded;
    }
    return { ...observation, body: { status: 'complete', mediaType: mediaType ?? 'application/octet-stream', bytes: got.content ?? new Uint8Array(), metadata } };
  });
  await readIndex();
  const after = await readTip();
  if (after.network !== before.network || after.height !== before.height || after.hash !== before.hash) throw incomplete('SAT_SNAPSHOT_CHAIN_CHANGED', 'Core chain changed during sat observation');
  return { network: before.network, sat: satoshi, tipBefore: { height: before.height, hash: before.hash },
    tipAfter: { height: after.height, hash: after.hash }, indexTip, indexHealthy: true, enumerationComplete: true,
    blocks: (await Promise.all(blocks.values())).sort((a, b) => a.height - b.height), publications, bodies: limits.bodies, ownership: { owner: sat.address, satpoint: sat.satpoint } };
}
