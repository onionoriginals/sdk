import { afterEach, describe, expect, test } from 'bun:test';
import { QuickNodeProvider } from '../../../src/adapters/providers/QuickNodeProvider';
import { RegtestProvider } from '../../../src/adapters/providers/RegtestProvider';

const nativeFetch = globalThis.fetch;
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { server?.stop(true); globalThis.fetch = nativeFetch; });
const txid = 'a'.repeat(64), hash = 'b'.repeat(64), id = txid + 'i0';

function fixture(kind: 'quicknode' | 'regtest', options: {
  encoding?: 'auto' | 'utf8' | 'base64'; metadata?: unknown; content?: Uint8Array;
  info?: Record<string, unknown>; status?: Record<string, unknown>; statusAfter?: Record<string, unknown>; sat?: Record<string, unknown>;
  rawContent?: boolean; missingMethod?: string; wrapContent?: boolean; blockTxs?: string[]; coreAfterHash?: string; indexAfterHash?: string;
  snapshotBudget?: { timeoutMs?: number; maxRequests?: number }; delayStatusMs?: number;
  metadataHttpStatus?: number; metadataHttpBody?: string; delayMetadataMs?: number; maxJsonBytes?: number;
} = {}) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let statuses = 0, tips = 0, indexHashes = 0;
  const chain = kind === 'regtest' ? 'regtest' : 'main';
  const status = { chain: kind === 'regtest' ? 'regtest' : 'mainnet', height: 100, sat_index: true, address_index: true, inscription_index: true, unrecoverably_reorged: false, ...options.status };
  const sat = { number: 123, inscriptions: [id], address: 'holder', satpoint: txid + ':0:0', ...options.sat };
  const info = { id, sat: 123, height: 100, content_type: 'image/png', content_length: 3, ...options.info };
  const content = options.content ?? new Uint8Array([0, 255, 1]);
  // Indefinite-length CBOR deliberately differs from any canonical re-encoding.
  const metadata = options.metadata === undefined ? 'bf636c6f679fffff' : options.metadata;
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method === 'POST') {
      const { method, params } = await req.json() as { method: string; params: unknown[] };
      calls.push({ method, params });
      if (method === 'ord_getStatus' && options.delayStatusMs) await Bun.sleep(options.delayStatusMs);
      if (method === options.missingMethod) return Response.json({ error: { code: -32601, message: 'Method not found' } });
      let result: unknown;
      switch (method) {
        case 'getblockchaininfo': result = { chain, blocks: 100, bestblockhash: ++tips > 1 ? options.coreAfterHash ?? hash : hash }; break;
        case 'getblockhash': result = hash; break;
        case 'getblock': result = { hash, height: 100, confirmations: 1, tx: options.blockTxs ?? ['c'.repeat(64), txid] }; break;
        case 'ord_getStatus': result = ++statuses > 1 ? { ...status, ...options.statusAfter } : status; break;
        case 'ord_getBlockHash': result = ++indexHashes > 1 ? options.indexAfterHash ?? hash : hash; break;
        case 'ord_getSat': result = sat; break;
        case 'ord_getInscription': result = info; break;
        case 'ord_getContent': result = options.encoding === 'utf8' ? new TextDecoder().decode(content) : Buffer.from(content).toString('base64'); break;
        case 'ord_getMetadata': result = metadata; break;
        default: return Response.json({ error: { code: -32601, message: 'Method not found' } });
      }
      if (method === 'ord_getContent' && options.wrapContent) result = { content: result };
      return Response.json({ result });
    }
    const path = new URL(req.url).pathname;
    if (path === '/status') {
      calls.push({ method: 'status', params: [] });
      if (options.delayStatusMs) await Bun.sleep(options.delayStatusMs);
      return Response.json(++statuses > 1 ? { ...status, ...options.statusAfter } : status);
    }
    calls.push({ method: path, params: [] });
    if (path.startsWith('/blockhash/')) return new Response(++indexHashes > 1 ? options.indexAfterHash ?? hash : hash);
    if (path === '/sat/123') return Response.json(sat);
    if (path === '/inscription/' + id) return Response.json(info);
    if (path === '/content/' + id) return new Response(content);
    if (path === '/r/metadata/' + id) {
      if (options.delayMetadataMs) await Bun.sleep(options.delayMetadataMs);
      if (options.metadataHttpStatus) return new Response(options.metadataHttpBody ?? '', { status: options.metadataHttpStatus });
      return metadata === null ? new Response(`inscription ${id} metadata not found`, { status: 404 }) : Response.json(metadata);
    }
    return new Response('', { status: 404 });
  } });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).hostname !== '127.0.0.1') throw new Error('Only loopback permitted');
    return nativeFetch(input, init);
  }) as typeof fetch;
  const provider = kind === 'regtest'
    ? new RegtestProvider({ rpcUrl: server.url.href, ordUrl: server.url.href, rpcAuth: 'test:only', snapshotBudget: options.snapshotBudget })
    : new QuickNodeProvider({ endpoint: server.url.href, contentEncoding: options.encoding ?? 'base64', ...(options.rawContent ? { contentBaseUrl: server.url.href } : {}), snapshotBudget: options.snapshotBudget, maxJsonBytes: options.maxJsonBytes });
  return { provider, calls };
}

for (const kind of ['quicknode', 'regtest'] as const) describe(`${kind} CEL 3 snapshot`, () => {
  test('reads complete ownership and publication bytes without the inverse address index', async () => {
    const { provider, calls } = fixture(kind, { status: { address_index: false } });
    const result = await provider.getSatSnapshot('123');
    expect(result.indexHealthy).toBe(true);
    expect(result.enumerationComplete).toBe(true);
    expect(result.ownership).toEqual({ owner: 'holder', satpoint: txid + ':0:0' });
    expect(result.publications[0].body).toMatchObject({ status: 'complete', bytes: new Uint8Array([0, 255, 1]) });
    expect(calls.some(call => /address/i.test(call.method))).toBe(false);
  });
  for (const field of ['address', 'satpoint']) test(`rejects missing ${field} without address indexing`, async () => {
    const { provider } = fixture(kind, { status: { address_index: false }, sat: { [field]: undefined } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/ownership/i);
  });
  for (const field of ['sat_index', 'inscription_index']) test(`still requires ${field} without address indexing`, async () => {
    const { provider } = fixture(kind, { status: { address_index: false, [field]: false } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/index/i);
  });
  test('fails closed at the total request budget before downloading the enumeration', async () => {
    const { provider, calls } = fixture(kind, { snapshotBudget: { maxRequests: 4 }, sat: { inscriptions: Array.from({ length: 1000 }, (_, index) => txid + 'i' + index) } });
    await expect(provider.getSatSnapshot('123')).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_BUDGET_EXCEEDED' });
    expect(calls).toHaveLength(4);
  });
  test('bounds a stalled dependency by the snapshot deadline and stops subsequent reads', async () => {
    const { provider, calls } = fixture(kind, { snapshotBudget: { timeoutMs: 20 }, delayStatusMs: 100 });
    const started = performance.now();
    await expect(provider.getSatSnapshot('123')).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_BUDGET_EXCEEDED' });
    expect(performance.now() - started).toBeLessThan(90);
    await Bun.sleep(110);
    expect(calls).toHaveLength(2);
  });
  test('retains exact body and raw CBOR with Core creation order and ownership', async () => {
    const { provider, calls } = fixture(kind);
    const result = await provider.getSatSnapshot('123');
    expect(result.indexHealthy).toBe(true);
    expect(result.enumerationComplete).toBe(true);
    expect(result.ownership).toEqual({ owner: 'holder', satpoint: txid + ':0:0' });
    expect(result.publications[0].body).toEqual({ status: 'complete', mediaType: 'image/png', bytes: new Uint8Array([0, 255, 1]), metadata: new Uint8Array([191, 99, 108, 111, 103, 159, 255, 255]) });
    expect(result.publications[0].creation).toEqual({ height: 100, blockHash: hash, transactionIndex: 1, inscriptionIndex: 0 });
    expect(calls.some(call => call.method === 'getblock' && call.params[1] === 1)).toBe(true);
  });
  test('rejects a truncated body instead of attesting complete bytes', async () => {
    const { provider } = fixture(kind, { content: new Uint8Array([0, 255]) });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/content|body/i);
  });
  test('rejects delegated content', async () => {
    const { provider } = fixture(kind, { info: { delegate: 'd'.repeat(64) + 'i0' } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/delegat/i);
  });
  test('rejects missing content type rather than hiding a continuation', async () => {
    const { provider } = fixture(kind, { info: { content_type: undefined } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/content/i);
  });
  test('rejects missing content length', async () => {
    const { provider } = fixture(kind, { info: { content_length: undefined } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/content|body/i);
  });
  test('rejects decoded metadata objects', async () => {
    const { provider } = fixture(kind, { metadata: { log: [] } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/metadata/i);
  });
  test('rechecks index health after reading publications', async () => {
    const { provider } = fixture(kind, { statusAfter: { sat_index: false } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/index/i);
  });
  test('rejects an unavailable inscription index', async () => {
    const { provider } = fixture(kind, { statusAfter: { inscription_index: false } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/index/i);
  });
  test('rejects unknown reorg health', async () => {
    const { provider } = fixture(kind, { statusAfter: { unrecoverably_reorged: undefined } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/index/i);
  });
  test('rechecks the indexed block hash after reading publications', async () => {
    const { provider } = fixture(kind, { indexAfterHash: 'e'.repeat(64) });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/index/i);
  });
  test('rejects a changed Core tip', async () => {
    const { provider } = fixture(kind, { coreAfterHash: 'd'.repeat(64) });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/chain changed/i);
  });
  test('rejects a listed reveal absent from its claimed active block', async () => {
    const { provider } = fixture(kind, { blockTxs: ['c'.repeat(64)] });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/block|reveal/i);
  });
  test('rejects incomplete ownership even for an empty sat', async () => {
    const { provider } = fixture(kind, { sat: { inscriptions: [], address: undefined } });
    await expect(provider.getSatSnapshot('123')).rejects.toThrow(/ownership/i);
  });
  test('accepts explicit metadata absence and an empty inscription body', async () => {
    const { provider } = fixture(kind, { metadata: null, info: { content_length: 0 }, content: new Uint8Array() });
    const result = await provider.getSatSnapshot('123');
    expect(result.publications[0].body).toMatchObject({ status: 'complete', bytes: new Uint8Array(), metadata: null });
  });
});

test('QuickNode snapshots refuse heuristic content encoding before RPC', async () => {
  const { provider, calls } = fixture('quicknode', { encoding: 'auto' });
  await expect(provider.getSatSnapshot('123')).rejects.toThrow(/encoding/i);
  expect(calls).toEqual([]);
});
test('QuickNode snapshots refuse an unavailable raw metadata capability', async () => {
  const { provider } = fixture('quicknode', { missingMethod: 'ord_getMetadata' });
  await expect(provider.getSatSnapshot('123')).rejects.toThrow(/Method not found/i);
});

test('QuickNode accepts its documented literal UTF-8 content wrapper without guessing base64', async () => {
  const content = new TextEncoder().encode('test');
  const { provider } = fixture('quicknode', { encoding: 'utf8', wrapContent: true, content, info: { content_type: 'text/plain', content_length: 4 } });
  const snapshot = await provider.getSatSnapshot('123');
  expect(snapshot.publications[0].body).toMatchObject({ status: 'complete', bytes: content });
});


test('QuickNode raw content endpoint preserves PNG bytes without guessing JSON string encoding', async () => {
  const { provider, calls } = fixture('quicknode', { rawContent: true, encoding: 'auto' });
  const snapshot = await provider.getSatSnapshot('123');
  expect(snapshot.publications[0].body).toMatchObject({ bytes: new Uint8Array([0, 255, 1]) });
  expect(calls.some(call => call.method === 'ord_getContent')).toBe(false);
});

test('QuickNode raw gateway retains exact CBOR without the RPC metadata wrapper', async () => {
  const { provider, calls } = fixture('quicknode', { rawContent: true, missingMethod: 'ord_getMetadata' });
  const snapshot = await provider.getSatSnapshot('123');
  expect(snapshot.publications[0].body).toMatchObject({ metadata: new Uint8Array([191, 99, 108, 111, 103, 159, 255, 255]) });
  expect(calls.some(call => call.method === 'ord_getMetadata')).toBe(false);
});

test('QuickNode raw gateway recognizes explicit metadata absence for the listed inscription', async () => {
  const { provider } = fixture('quicknode', { rawContent: true, metadata: null, missingMethod: 'ord_getMetadata' });
  expect((await provider.getSatSnapshot('123')).publications[0].body).toMatchObject({ metadata: null });
});

for (const [status, body] of [[500, 'Internal error'], [404, 'Not found'], [404, `inscription ${'d'.repeat(64)}i0 metadata not found`]] as const) {
  test(`QuickNode raw metadata refuses ${status} without the matching absence marker`, async () => {
    const { provider } = fixture('quicknode', { rawContent: true, metadataHttpStatus: status, metadataHttpBody: body });
    await expect(provider.getSatSnapshot('123')).rejects.toMatchObject({ code: 'QUICKNODE_METADATA_UNAVAILABLE' });
  });
}

test('QuickNode raw gateway rejects decoded metadata objects', async () => {
  const { provider } = fixture('quicknode', { rawContent: true, metadata: { log: [] } });
  await expect(provider.getSatSnapshot('123')).rejects.toThrow(/metadata/i);
});

test('QuickNode raw gateway rejects a success response with ambiguous null metadata', async () => {
  const { provider } = fixture('quicknode', { rawContent: true, metadataHttpStatus: 200, metadataHttpBody: 'null' });
  await expect(provider.getSatSnapshot('123')).rejects.toMatchObject({ code: 'QUICKNODE_METADATA_UNAVAILABLE' });
});

test('QuickNode raw metadata remains inside the total snapshot deadline', async () => {
  const { provider, calls } = fixture('quicknode', { rawContent: true, delayMetadataMs: 150, snapshotBudget: { timeoutMs: 100 } });
  await expect(provider.getSatSnapshot('123')).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_BUDGET_EXCEEDED' });
  expect(calls.at(-1)?.method).toBe('/r/metadata/' + id);
  await Bun.sleep(170);
  expect(calls.at(-1)?.method).toBe('/r/metadata/' + id);
});

test('QuickNode raw metadata enforces its configured response size cap', async () => {
  const { provider } = fixture('quicknode', { rawContent: true, maxJsonBytes: 1024, metadata: 'ab'.repeat(1024) });
  await expect(provider.getSatSnapshot('123')).rejects.toMatchObject({ code: 'QUICKNODE_RESPONSE_TOO_LARGE' });
});
