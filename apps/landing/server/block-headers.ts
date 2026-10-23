/**
 * Block headers over Bitcoin Core JSON-RPC (`getblockhash`, `getblockheader`):
 * the time, hash and previous hash an InscriptionClock needs (P9.15), for the
 * server's own writer and for the browser's header route. QuickNode answers
 * the same two methods on its endpoint; the local regtest node answers them
 * with rpcauth.
 */
export type HeaderSource = (height: number) => Promise<{ time: number; hash: string; prev?: string }>;

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
