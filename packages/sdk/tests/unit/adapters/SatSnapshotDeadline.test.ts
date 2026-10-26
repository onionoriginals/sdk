import { afterEach, describe, expect, test } from 'bun:test';
import { QuickNodeProvider } from '../../../src/adapters/providers/QuickNodeProvider';
import { RegtestProvider } from '../../../src/adapters/providers/RegtestProvider';

const nativeFetch = globalThis.fetch;
const hash = 'b'.repeat(64);
afterEach(() => { globalThis.fetch = nativeFetch; });

for (const kind of ['quicknode', 'regtest'] as const) describe(`${kind} snapshot deadline`, () => {
  test('bounds a stalled dependency by the snapshot deadline and stops subsequent reads', async () => {
    const provider = kind === 'regtest'
      ? new RegtestProvider({ rpcUrl: 'http://127.0.0.1:1', ordUrl: 'http://127.0.0.1:1', rpcAuth: 'test:only', snapshotBudget: { timeoutMs: 20 } })
      : new QuickNodeProvider({ endpoint: 'http://127.0.0.1:1', contentEncoding: 'base64', snapshotBudget: { timeoutMs: 20 } });
    const requests: Array<RequestInit | undefined> = [];
    let release!: (response: Response) => void;
    const stalled = new Promise<Response>(resolve => { release = resolve; });
    // Stall the first transport call deterministically. A loopback server may
    // receive only one of two requests before a 20 ms deadline on a busy runner.
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init);
      return stalled;
    }) as typeof fetch;
    try {
      await expect(provider.getSatSnapshot('123')).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_BUDGET_EXCEEDED' });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.signal?.aborted).toBe(true);
    } finally {
      // A dependency that ignores cancellation and resolves late must not
      // restart the snapshot or cause another read.
      release(Response.json({ result: { chain: kind === 'regtest' ? 'regtest' : 'main', blocks: 100, bestblockhash: hash } }));
    }
    await Bun.sleep(0);
    expect(requests).toHaveLength(1);
  }, 1000);
});
