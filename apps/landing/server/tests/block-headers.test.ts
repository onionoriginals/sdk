import { describe, expect, test } from 'bun:test';
import { coreBlockHeaderBatches, coreBlockHeaders } from '../block-headers';

const H = (n: number) => n.toString(16).padStart(64, '0');

function core(answers: Record<string, (params: unknown[]) => unknown>, seen: Array<{ method: string; auth: string | null }> = []) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    seen.push({ method, auth: new Headers(init?.headers).get('authorization') });
    const answer = answers[method];
    return answer ? Response.json({ result: answer(params), error: null }) : Response.json({ result: null, error: { message: 'Method not found' } });
  }) as typeof fetch;
}

describe('block headers over Core RPC (P9.15)', () => {
  test('time, hash and previous hash for a height, with rpcauth when given', async () => {
    const seen: Array<{ method: string; auth: string | null }> = [];
    const headers = coreBlockHeaders({
      rpcUrl: 'http://127.0.0.1:18443', rpcAuth: 'u:p',
      fetchImpl: core({ getblockhash: ([h]) => H(h as number), getblockheader: ([hash]) => ({ hash, time: 1_700_000_000, previousblockhash: H(6) }) }, seen),
    });
    expect(await headers(7)).toEqual({ time: 1_700_000_000, hash: H(7), prev: H(6) });
    expect(seen).toEqual([{ method: 'getblockhash', auth: `Basic ${btoa('u:p')}` }, { method: 'getblockheader', auth: `Basic ${btoa('u:p')}` }]);
  });

  test('a header for another block, or an RPC error, is refused', async () => {
    const wrong = coreBlockHeaders({ rpcUrl: 'http://x', fetchImpl: core({ getblockhash: () => H(7), getblockheader: () => ({ hash: H(8), time: 1 }) }) });
    await expect(wrong(7)).rejects.toThrow('does not describe');
    const missing = coreBlockHeaders({ rpcUrl: 'http://x', fetchImpl: core({}) });
    await expect(missing(7)).rejects.toThrow('Method not found');
  });
});

describe('batched headers for the server clock (P9.15)', () => {
  const TIP = 5;
  const batchCore = (requests: number[]) => (async (_url: string | URL | Request, init?: RequestInit) => {
    const calls = JSON.parse(String(init?.body)) as Array<{ id: number; method: string; params: [number | string] }>;
    requests.push(calls.length);
    return Response.json(calls.map(({ id, method, params: [p] }) => {
      if (method === 'getblockhash') return (p as number) <= TIP ? { id, result: H(p as number), error: null } : { id, result: null, error: { code: -8, message: 'Block height out of range' } };
      const h = parseInt(p as string, 16);
      return { id, result: { hash: p, time: 1000 + h, ...(h > 0 ? { previousblockhash: H(h - 1) } : {}) }, error: null };
    }));
  }) as typeof fetch;

  test('two requests for a run of headers, ending at the tip', async () => {
    const requests: number[] = [];
    const batches = coreBlockHeaderBatches({ rpcUrl: 'http://x', fetchImpl: batchCore(requests) });
    expect(await batches(3, 10)).toEqual([
      { time: 1003, hash: H(3), prev: H(2) }, { time: 1004, hash: H(4), prev: H(3) }, { time: 1005, hash: H(5), prev: H(4) },
    ]);
    expect(requests).toEqual([10, 3]);
    expect(await batches(6, 10)).toEqual([]);
  });
});
