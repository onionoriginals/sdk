import { normalizeTxid, type SatSnapshot } from '@originals/cel/v3';
import { StructuredError } from '@originals/cel';
import { base64 } from '@scure/base';
import { readResponseBodyCapped } from '../adapters/response-body-limit.js';

/** Application-selected verification of chain facts; never discovers trust from provider data. */
export type ChainValidator = (snapshot: Readonly<SatSnapshot>) => Promise<void | { source?: string }>;

export interface BitcoinCoreChainValidatorOptions {
  /** A separately operated Bitcoin Core RPC endpoint. Credentials belong in rpcAuth, not the URL. */
  endpoint: string;
  rpcAuth?: { username: string; password: string };
  fetchImpl?: typeof fetch;
  /** Whole validation deadline, including streamed response bodies. Default 15 seconds. */
  timeoutMs?: number;
  /**
   * Maximum total RPC calls per validation. Default 512, matching the
   * primary snapshot reader's own default request budget
   * (`SatSnapshotBudget.maxRequests` in `adapters/providers/sat-snapshot.ts`).
   * Validation costs exactly `2 * snapshot.blocks.length + 2` requests (one
   * tip check before and after, plus `getblockhash` + `getblock` per distinct
   * active block) — a legitimate snapshot with more distinct blocks than
   * `(maxRequests - 2) / 2` fails closed with `SAT_SNAPSHOT_BUDGET_EXCEEDED`
   * even with no disagreement, so raise this alongside a larger configured
   * `SatSnapshotBudget` rather than assuming the default covers it.
   */
  maxRequests?: number;
  /** Streaming limit for each RPC response. Default 8 MiB. */
  maxResponseBytes?: number;
}

const networks: Record<string, SatSnapshot['network']> = {
  main: 'mainnet', test: 'testnet', testnet3: 'testnet', testnet4: 'testnet', signet: 'signet', regtest: 'regtest',
};
const positive = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
// Block/tx hashes carry no casing contract of their own: Bitcoin Core's RPC
// and a configured SatProvider can each report the same hash in different,
// individually valid hex letter case (see #844). Normalize both sides with
// the same rule used for txid comparisons elsewhere before comparing, so
// agreeing evidence in different casing isn't treated as a disagreement.
const hex = (value: unknown): string => (typeof value === 'string' ? normalizeTxid(value) : String(value));

/**
 * Cross-check active tip, block hashes and complete ordered transaction lists with
 * an independently configured Core node. This does not authenticate Ordinals
 * enumeration, sat ownership/trajectory, or provider-supplied inscription bytes.
 */
export function createBitcoinCoreChainValidator(options: BitcoinCoreChainValidatorOptions): ChainValidator {
  const endpoint = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new StructuredError('CHAIN_VALIDATOR_CONFIG', 'Use an HTTP(S) Core endpoint without URL credentials or a fragment');
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.rpcAuth) headers.set('authorization', 'Basic ' + base64.encode(
    new TextEncoder().encode(`${options.rpcAuth.username}:${options.rpcAuth.password}`)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positive(options.timeoutMs, 15_000);
  const maxRequests = positive(options.maxRequests, 512);
  const maxBytes = positive(options.maxResponseBytes, 8 * 1024 * 1024);
  const unavailable = () => new StructuredError('SAT_SNAPSHOT_CHAIN_UNAVAILABLE', 'Independent Bitcoin Core validation is unavailable');
  const disagreement = () => new StructuredError('SAT_SNAPSHOT_CHAIN_DISAGREEMENT', 'Independent Bitcoin Core disagrees with the snapshot chain evidence');
  return async snapshot => {
    const controller = new AbortController();
    const budgetExceeded = () => new StructuredError('SAT_SNAPSHOT_BUDGET_EXCEEDED', 'Independent chain validation budget exceeded');
    let requests = 0;
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectDeadline(budgetExceeded()); }, timeoutMs);
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      if (controller.signal.aborted || ++requests > maxRequests) throw budgetExceeded();
      try {
        const response = await fetchImpl(endpoint.href, { method: 'POST', headers, signal: controller.signal,
          redirect: 'error', credentials: 'omit', cache: 'no-store', body: JSON.stringify({ jsonrpc: '2.0', id: requests, method, params }) });
        if (!response.ok) throw unavailable();
        const body = object(JSON.parse(new TextDecoder().decode(await readResponseBodyCapped(response, maxBytes))));
        if (body.error || !('result' in body)) throw unavailable();
        return body.result;
      } catch {
        if (controller.signal.aborted) throw budgetExceeded();
        throw unavailable();
      }
    };
    const checkTip = async (tip: SatSnapshot['tipBefore']) => {
      const info = object(await rpc('getblockchaininfo', []));
      if (!tip || typeof info.chain !== 'string' || networks[info.chain] !== snapshot.network ||
          info.blocks !== tip.height || hex(info.bestblockhash) !== hex(tip.hash)) throw disagreement();
    };
    const validate = async () => {
      await checkTip(snapshot.tipBefore);
      for (const block of snapshot.blocks) {
        const hash = await rpc('getblockhash', [block.height]);
        if (hex(hash) !== hex(block.hash)) throw disagreement();
        const observed = object(await rpc('getblock', [hash, 1]));
        if (hex(observed.hash) !== hex(block.hash) || observed.height !== block.height || !Array.isArray(observed.tx) ||
            observed.tx.length !== block.txids.length || observed.tx.some((id, i) => hex(id) !== hex(block.txids[i]))) throw disagreement();
      }
      await checkTip(snapshot.tipAfter);
      return { source: endpoint.origin };
    };
    try { return await Promise.race([validate(), deadline]); } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
