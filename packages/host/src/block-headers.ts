/**
 * Block headers over Bitcoin Core JSON-RPC (`getblockhash`, `getblockheader`):
 * the time, hash and previous hash the server's InscriptionClock needs
 * (P9.15); the browser asks that clock (/api/btc/inscription-time). QuickNode answers
 * the same two methods on its endpoint; the local regtest node answers them
 * with rpcauth.
 */
export type HeaderSource = (height: number) => Promise<{ time: number; hash: string; prev?: string }>;
export type HeaderBatches = (from: number, count: number) => Promise<Array<{ time: number; hash: string; prev?: string }>>;

export function coreBlockHeaders(opts: { rpcUrl: string; rpcAuth?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): HeaderSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetchImpl(opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.rpcAuth ? { authorization: `Basic ${btoa(opts.rpcAuth)}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'landing-headers', method, params }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`${method} failed (${res.status})`);
    const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } | null } | null;
    if (!body || body.error || body.result === undefined) throw new Error(`${method}: ${body?.error?.message ?? 'unusable body'}`);
    return body.result;
  }
  return async (height) => {
    const hash = await rpc<string>('getblockhash', [height]);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('getblockhash returned no block hash');
    const header = await rpc<{ time: number; hash?: string; previousblockhash?: string }>('getblockheader', [hash]);
    if (typeof header.time !== 'number' || (header.hash !== undefined && header.hash !== hash)) throw new Error('getblockheader does not describe the block asked for');
    return { time: header.time, hash, ...(header.previousblockhash ? { prev: header.previousblockhash } : {}) };
  };
}

/**
 * Consecutive headers in two JSON-RPC batches (`getblockhash` for each height,
 * then `getblockheader` for each hash), so the server's clock appends a
 * thousand blocks per round trip instead of one (InscriptionClock `headers`).
 * Fewer come back at the tip. Each header must name the hash asked for and,
 * but for genesis, its parent.
 */
export function coreBlockHeaderBatches(opts: { rpcUrl: string; rpcAuth?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): HeaderBatches {
  const fetchImpl = opts.fetchImpl ?? fetch;
  async function batch<T>(calls: Array<{ method: string; params: unknown[] }>): Promise<Array<{ result?: T; error?: { code?: number; message?: string } | null }>> {
    const res = await fetchImpl(opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.rpcAuth ? { authorization: `Basic ${btoa(opts.rpcAuth)}` } : {}) },
      body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, ...c }))),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`header batch failed (${res.status})`);
    const body = (await res.json().catch(() => null)) as Array<{ id: number; result?: T; error?: { code?: number; message?: string } | null }> | null;
    if (!Array.isArray(body)) throw new Error('header batch: unusable body');
    return calls.map((_, id) => body.find((b) => b.id === id) ?? { error: { message: 'missing answer' } });
  }
  return async (from, count) => {
    const heights = Array.from({ length: count }, (_, k) => from + k);
    const hashes: string[] = [];
    for (const answer of await batch<string>(heights.map((h) => ({ method: 'getblockhash', params: [h] })))) {
      // Past the tip Core answers "Block height out of range": the batch ends there.
      if (answer.error || typeof answer.result !== 'string') break;
      if (!/^[0-9a-f]{64}$/.test(answer.result)) throw new Error('getblockhash returned no block hash');
      hashes.push(answer.result);
    }
    if (hashes.length === 0) return [];
    const headers = await batch<{ time: number; hash?: string; previousblockhash?: string }>(hashes.map((h) => ({ method: 'getblockheader', params: [h] })));
    return hashes.map((hash, k) => {
      const header = headers[k].result;
      if (!header || typeof header.time !== 'number' || (header.hash !== undefined && header.hash !== hash)) throw new Error(`getblockheader does not describe block ${hash}`);
      return { time: header.time, hash, ...(header.previousblockhash ? { prev: header.previousblockhash } : {}) };
    });
  };
}
