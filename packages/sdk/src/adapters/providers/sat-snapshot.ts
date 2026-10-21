import type { BitcoinNetwork, SatSnapshot } from '../../bitcoin/sat-snapshot-types.js';
import { MAX_SATOSHI_SUPPLY } from '../../utils/satoshi-validation.js';
import { OriginalsError } from '@originals/vh';
import { hexToBytes } from '../../utils/encoding.js';

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
  /** Total time for one complete observation, including stalled reads (default 30 seconds, at most 120). */
  timeoutMs?: number;
  /**
   * Total upstream requests for one observation. By default the budget
   * scales with the inscriptions the index lists: 7 + 5 per inscription
   * (`/inscription`, at most two Core block reads, body and metadata), so a
   * sat with many entries is read in full; `maxInscriptions` bounds it. An
   * explicit value is kept as given (at most 1,000,000). No partial result is
   * returned.
   */
  maxRequests?: number;
  /** Inscriptions a sat may list before the read is refused (default 10,000, at most 100,000). */
  maxInscriptions?: number;
  /**
   * Body and metadata bytes read in one observation (default 32 MiB, at most
   * 512 MiB). A body that would pass it is reported observed but unread
   * (`{ status: 'unavailable', reason: 'over-budget' }`) and the read goes on.
   */
  maxContentBytes?: number;
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

/**
 * One complete, stable sat observation: no decoded metadata, no delegated or
 * encoded bytes taken as a body, no moving index. Delegated and encoded
 * inscriptions, and bodies past the byte budget, are reported observed but
 * unread instead of failing the read, so the holder of a sat cannot make
 * every read of it fail (P9.12). Every failure is an `OriginalsError` with a
 * section 6 category.
 */
export async function readSatSnapshot(reader: SatSnapshotReader, satoshi: string, expectedNetwork?: BitcoinNetwork, budget: SatSnapshotBudget = {}): Promise<SatSnapshot> {
  const timeoutMs = within(budget.timeoutMs, 30_000, 120_000);
  const explicitRequests = within(budget.maxRequests, 0, 1_000_000);
  const maxInscriptions = within(budget.maxInscriptions, 10_000, 100_000, true);
  const maxContentBytes = within(budget.maxContentBytes, 32 * 1024 * 1024, 512 * 1024 * 1024, true);
  if ([timeoutMs, explicitRequests, maxInscriptions, maxContentBytes].some(Number.isNaN)) {
    throw invalid('SAT_SNAPSHOT_BUDGET_INVALID', 'Invalid sat snapshot budget');
  }
  const exhausted = () => incomplete('SAT_SNAPSHOT_BUDGET_EXCEEDED', 'Complete sat observation exceeded its total request or time budget', { maxRequests, timeoutMs });
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(exhausted()), timeoutMs);
  let requests = 0;
  // Until the index lists the sat's inscriptions, only the fixed reads are allowed.
  let maxRequests = budget.maxRequests !== undefined ? explicitRequests : FIXED_REQUESTS;
  const call = async <T>(read: () => Promise<T>): Promise<T> => {
    if (requests >= maxRequests || performance.now() >= deadline) controller.abort(exhausted());
    controller.signal.throwIfAborted();
    requests++;
    // Race also bounds a transport that ignores cancellation. Its completion
    // cannot resume the scan; compliant transports abort their in-flight read.
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([new Promise<never>((_, reject) => {
        onAbort = () => reject(exhausted());
        controller.signal.addEventListener('abort', onAbort, { once: true });
      }), read()]);
    } finally { controller.signal.removeEventListener('abort', onAbort); }
  };
  const signal = controller.signal;
  try {
    return await collectSatSnapshot({
      rpc: (method, params) => call(() => reader.rpc(method, params, signal)),
      status: () => call(() => reader.status(signal)),
      indexHash: height => call(() => reader.indexHash(height, signal)),
      sat: sat => call(() => reader.sat(sat, signal)),
      inscription: id => call(() => reader.inscription(id, signal)),
      content: id => call(() => reader.content(id, signal)),
      metadata: id => call(() => reader.metadata(id, signal)),
    }, satoshi, expectedNetwork, {
      maxInscriptions,
      maxContentBytes,
      listed: count => { if (budget.maxRequests === undefined) maxRequests = FIXED_REQUESTS + PER_INSCRIPTION * count; },
    });
  } finally { clearTimeout(timer); }
}

interface Limits {
  maxInscriptions: number;
  maxContentBytes: number;
  /** Called once the index has listed the sat's inscriptions. */
  listed(count: number): void;
}

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
  if (sat.inscriptions.length > limits.maxInscriptions) {
    throw incomplete('SAT_SNAPSHOT_TOO_MANY_INSCRIPTIONS', `The sat lists ${sat.inscriptions.length} inscriptions, more than maxInscriptions ${limits.maxInscriptions}`,
      { inscriptions: sat.inscriptions.length, maxInscriptions: limits.maxInscriptions });
  }
  limits.listed(sat.inscriptions.length);
  const blocks = new Map<number, SatSnapshot['blocks'][number]>();
  const publications: SatSnapshot['publications'] = [];
  const seen = new Set<string>();
  let contentBytes = 0;
  for (const id of sat.inscriptions) {
    if (typeof id !== 'string' || !/^([0-9a-f]{64})i(0|[1-9]\d*)$/.test(id) || seen.has(id)) throw invalid('SAT_SNAPSHOT_INSCRIPTION_ID', 'Invalid or duplicate inscription id');
    seen.add(id);
    const [txid, index] = id.split('i');
    if (!integer(Number(index))) throw invalid('SAT_SNAPSHOT_INSCRIPTION_ID', 'Invalid inscription index');
    const info = object(await reader.inscription(id));
    if (info.id !== id || !integer(info.sat) || String(info.sat) !== satoshi || !integer(info.height) || info.height > before.height)
      throw incomplete('SAT_SNAPSHOT_INSCRIPTION_UNAVAILABLE', 'Listed inscription observation unavailable');
    if (!(info.content_type === null || typeof info.content_type === 'string') || !(info.content_length === null || integer(info.content_length)))
      throw incomplete('SAT_SNAPSHOT_INSCRIPTION_UNAVAILABLE', 'Explicit inscription content type and length required');
    const mediaType = info.content_type;
    let block = blocks.get(info.height);
    if (!block) {
      const blockHash = await reader.rpc('getblockhash', [info.height]);
      if (!hash(blockHash)) throw incomplete('SAT_SNAPSHOT_BLOCK_UNAVAILABLE', 'Active block hash unavailable');
      const observed = object(await reader.rpc('getblock', [blockHash, 1]));
      if (observed.hash !== blockHash || observed.height !== info.height || !integer(observed.confirmations) || observed.confirmations < 1 ||
          !Array.isArray(observed.tx) || !observed.tx.length || !observed.tx.every(hash) || new Set(observed.tx).size !== observed.tx.length)
        throw incomplete('SAT_SNAPSHOT_BLOCK_UNAVAILABLE', 'Active block observation unavailable');
      if (!integer(observed.time)) throw incomplete('SAT_SNAPSHOT_BLOCK_UNAVAILABLE', 'Active block timestamp unavailable');
      block = { height: info.height, hash: blockHash, txids: observed.tx, time: observed.time };
      blocks.set(info.height, block);
    }
    const transactionIndex = block.txids.indexOf(txid);
    if (transactionIndex < 0) throw invalid('SAT_SNAPSHOT_REVEAL_NOT_IN_BLOCK', 'Listed reveal is absent from its active block');
    const observation = { id, revealTxid: txid, network: before.network, sat: satoshi, confirmed: true,
      creation: { height: info.height, blockHash: block.hash, transactionIndex, inscriptionIndex: Number(index) } };
    // Observed, never taken as its own body: ord would serve another inscription's bytes, or encoded ones (P9.14).
    if (info.delegate != null || info.content_encoding != null) {
      publications.push({ ...observation, body: { status: 'unsupported', reason: info.delegate != null ? 'delegated' : 'content-encoding', mediaType } });
      continue;
    }
    const length = info.content_length ?? 0;
    if (contentBytes + length > limits.maxContentBytes) {
      publications.push({ ...observation, body: { status: 'unavailable', reason: 'over-budget', mediaType, contentLength: length } });
      continue;
    }
    const content = await reader.content(id);
    // Null explicitly reports a bodyless inscription. Never accept delegated/effective bytes as its own body.
    if ((content === null && info.content_length !== null) || (content?.length ?? 0) !== length)
      throw incomplete('SAT_SNAPSHOT_CONTENT_UNAVAILABLE', 'Listed inscription content is unavailable or has a different byte length');
    const metadataHex = await reader.metadata(id);
    if (metadataHex !== null && (typeof metadataHex !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(metadataHex)))
      throw incomplete('SAT_SNAPSHOT_METADATA_UNAVAILABLE', 'Raw metadata bytes unavailable');
    const metadata = metadataHex === null ? null : hexToBytes(metadataHex);
    if (contentBytes + length + (metadata?.length ?? 0) > limits.maxContentBytes) {
      // The metadata, whose length the index does not report beforehand, passed the budget.
      publications.push({ ...observation, body: { status: 'unavailable', reason: 'over-budget', mediaType, contentLength: length } });
      continue;
    }
    contentBytes += length + (metadata?.length ?? 0);
    publications.push({ ...observation, body: { status: 'complete', mediaType: mediaType ?? 'application/octet-stream', bytes: content ?? new Uint8Array(), metadata } });
  }
  await readIndex();
  const after = await readTip();
  if (after.network !== before.network || after.height !== before.height || after.hash !== before.hash) throw incomplete('SAT_SNAPSHOT_CHAIN_CHANGED', 'Core chain changed during sat observation');
  return { network: before.network, sat: satoshi, tipBefore: { height: before.height, hash: before.hash },
    tipAfter: { height: after.height, hash: after.hash }, indexTip, indexHealthy: true, enumerationComplete: true,
    blocks: [...blocks.values()], publications, ownership: { owner: sat.address, satpoint: sat.satpoint } };
}
