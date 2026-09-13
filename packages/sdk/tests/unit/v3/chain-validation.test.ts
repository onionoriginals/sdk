import { expect, test } from 'bun:test';
import { createBitcoinCoreChainValidator } from '../../../src/v3/chain-validation.js';
import type { SatSnapshot } from '@originals/cel/v3';
const hash = 'a'.repeat(64), tx = 'b'.repeat(64);
const snapshot = { network: 'regtest', tipBefore: { height: 1, hash }, tipAfter: { height: 1, hash },
  blocks: [{ height: 1, hash, txids: [tx] }] } as SatSnapshot;
function core(override?: (method: string) => unknown) {
  const calls: string[] = [];
  const fetchImpl = (async (url, init) => {
    expect(String(url)).toBe('http://localhost:18443/');
    expect(new Headers(init?.headers).get('authorization')).toBe('Basic dXNlcjpwYXNz');
    expect(init?.redirect).toBe('error');
    const { method } = JSON.parse(String(init?.body)); calls.push(method);
    const result = override?.(method) ?? ({ getblockchaininfo: { chain: 'regtest', blocks: 1, bestblockhash: hash },
      getblockhash: hash, getblock: { height: 1, hash, tx: [tx] } } as Record<string, unknown>)[method];
    return Response.json({ result, error: null });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const options = { endpoint: 'http://localhost:18443', rpcAuth: { username: 'user', password: 'pass' } };
test('authenticates Core and checks active tip, block identity, and complete ordered transaction membership', async () => {
  const mock = core();
  expect(await createBitcoinCoreChainValidator({ ...options, fetchImpl: mock.fetchImpl })(snapshot)).toEqual({ source: 'http://localhost:18443' });
  expect(mock.calls).toEqual(['getblockchaininfo', 'getblockhash', 'getblock', 'getblockchaininfo']);
});
test.each(['getblockchaininfo', 'getblockhash', 'getblock'])('rejects disagreeing %s', async method => {
  const mock = core(name => name === method ? (method === 'getblockhash' ? 'c'.repeat(64) : {}) : undefined);
  await expect(createBitcoinCoreChainValidator({ ...options, fetchImpl: mock.fetchImpl })(snapshot)).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_CHAIN_DISAGREEMENT' });
});
test('bounds total RPC calls and streamed response size', async () => {
  const mock = core();
  await expect(createBitcoinCoreChainValidator({ ...options, fetchImpl: mock.fetchImpl, maxRequests: 2 })(snapshot)).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_BUDGET_EXCEEDED' });
  expect(mock.calls).toHaveLength(2);
  await expect(createBitcoinCoreChainValidator({ ...options, fetchImpl: core().fetchImpl, maxResponseBytes: 8 })(snapshot)).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_CHAIN_UNAVAILABLE' });
});
test.each(['fetch', 'stream'])('whole deadline bounds a stuck %s even if transport ignores abort', async phase => {
  const fetchImpl = (async () => phase === 'fetch' ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ start() {} }))) as typeof fetch;
  await expect(createBitcoinCoreChainValidator({ ...options, fetchImpl, timeoutMs: 20 })(snapshot)).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_BUDGET_EXCEEDED' });
}, 1000);
test('default budget accommodates a legitimate snapshot with many distinct publication blocks', async () => {
  // 2 tip checks + 2 RPCs/block: 50 distinct blocks cost 102 requests, which
  // exceeded the old default of 100 with no actual disagreement (issue found
  // by review on #652) purely because the asset accumulated enough history.
  const blockHash = (height: number) => height.toString(16).padStart(64, '0');
  const blocks = Array.from({ length: 50 }, (_, i) => ({ height: i + 1, hash: blockHash(i + 1), txids: [tx] }));
  const busySnapshot = { network: 'regtest', tipBefore: { height: 50, hash: blockHash(50) },
    tipAfter: { height: 50, hash: blockHash(50) }, blocks } as SatSnapshot;
  const calls: string[] = [];
  const fetchImpl = (async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(method);
    if (method === 'getblockchaininfo') return Response.json({ result: { chain: 'regtest', blocks: 50, bestblockhash: blockHash(50) } });
    if (method === 'getblockhash') return Response.json({ result: blockHash(params[0] as number) });
    if (method === 'getblock') {
      const block = blocks.find(b => b.hash === params[0]);
      return Response.json({ result: { height: block!.height, hash: block!.hash, tx: block!.txids } });
    }
    throw new Error('unexpected method');
  }) as typeof fetch;
  const result = await createBitcoinCoreChainValidator({ ...options, fetchImpl })(busySnapshot);
  expect(result).toEqual({ source: 'http://localhost:18443' });
  expect(calls).toHaveLength(102);
});
test('rejects URL credentials and sanitizes transport errors', async () => {
  expect(() => createBitcoinCoreChainValidator({ endpoint: 'http://user:secret@localhost' })).toThrow();
  const fetchImpl = (async () => { throw new Error('user:secret'); }) as typeof fetch;
  await expect(createBitcoinCoreChainValidator({ ...options, fetchImpl })(snapshot)).rejects.toThrow('Independent Bitcoin Core validation is unavailable');
});
