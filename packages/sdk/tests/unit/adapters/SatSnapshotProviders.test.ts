import { afterEach, describe, expect, test } from 'bun:test';
import { QuickNodeProvider } from '../../../src/adapters/providers/QuickNodeProvider';
import { RegtestProvider } from '../../../src/adapters/providers/RegtestProvider';
import { readSatSnapshot, type SatSnapshotReader } from '../../../src/adapters/providers/sat-snapshot';
import { OriginalsError } from '@originals/vh';
import { ResponseTooLargeError } from '../../../src/adapters/response-body-limit';

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
        case 'getblock': result = { hash, height: 100, confirmations: 1, time: 1_760_000_000, tx: options.blockTxs ?? ['c'.repeat(64), txid] }; break;
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

for (const kind of ['quicknode', 'regtest'] as const) describe(`${kind} sat snapshot`, () => {
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
  test('reports delegated content as observed but unsupported, without reading it (M1; P9.12)', async () => {
    const { provider, calls } = fixture(kind, { info: { delegate: 'd'.repeat(64) + 'i0' } });
    const result = await provider.getSatSnapshot('123');
    expect(result.publications[0].body).toEqual({ status: 'unsupported', reason: 'delegated', mediaType: 'image/png' });
    expect(result.publications[0].creation).toEqual({ height: 100, blockHash: hash, transactionIndex: 1, inscriptionIndex: 0 });
    expect(calls.some(call => /content|metadata/i.test(call.method))).toBe(false);
  });
  test('reports an encoded body as observed but unsupported (M1; P9.14)', async () => {
    const { provider } = fixture(kind, { info: { content_encoding: 'br' } });
    expect((await provider.getSatSnapshot('123')).publications[0].body).toEqual({ status: 'unsupported', reason: 'content-encoding', mediaType: 'image/png' });
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

test('QuickNode RPC content path returns a plain Uint8Array, not a Buffer (#796)', async () => {
  const { provider } = fixture('quicknode', {});
  const snapshot = await provider.getSatSnapshot('123');
  const bytes = (snapshot.publications[0].body as { bytes: Uint8Array }).bytes;
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(Buffer.isBuffer(bytes)).toBe(false);
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

test('QuickNode raw metadata past its response size cap is observed but unread, not a failed read (P9.12)', async () => {
  const { provider } = fixture('quicknode', { rawContent: true, maxJsonBytes: 1024, metadata: 'ab'.repeat(1024) });
  const snapshot = await provider.getSatSnapshot('123');
  expect(snapshot.publications[0].body).toEqual({ status: 'unavailable', reason: 'over-budget', mediaType: 'image/png', contentLength: 3, metadataPresent: true });
});

test('QuickNode RPC metadata past its response size cap is observed but unread', async () => {
  const { provider } = fixture('quicknode', { maxJsonBytes: 1024, metadata: 'ab'.repeat(1024) });
  const snapshot = await provider.getSatSnapshot('123');
  expect(snapshot.publications[0].body).toMatchObject({ status: 'unavailable', reason: 'over-budget', metadataPresent: true });
});

test("providers pass bodies: 'originals' to the reader", async () => {
  for (const kind of ['quicknode', 'regtest'] as const) {
    const { provider, calls } = fixture(kind);
    const snapshot = await provider.getSatSnapshot('123', { bodies: 'originals' });
    expect(snapshot.publications[0].body).toMatchObject({ status: 'unavailable', reason: 'not-requested' });
    expect(calls.some((c) => /content|metadata/i.test(c.method))).toBe(false);
    server?.stop(true);
  }
});

/** An in-memory ord + Core holding `n` inscriptions on sat 123, one block each from height 10. */
function memoryReader(n: number, extra: (k: number) => Record<string, unknown> = () => ({}), length = () => 1) {
  const ids = Array.from({ length: n }, (_, k) => `${(k + 1).toString(16).padStart(64, 'e')}i0`);
  const calls: string[] = [];
  const reader: SatSnapshotReader = {
    rpc: async (method, params) => {
      calls.push(method);
      if (method === 'getblockchaininfo') return { chain: 'regtest', blocks: 20_000, bestblockhash: hash };
      if (method === 'getblockhash') return (params[0] as number).toString(16).padStart(64, '0');
      const height = parseInt(params[0] as string, 16);
      return { hash: params[0], height, confirmations: 1, tx: [ids[height - 10].slice(0, 64)], time: 1_700_000_000 };
    },
    status: async () => (calls.push('status'), { chain: 'regtest', height: 20_000, sat_index: true, inscription_index: true, unrecoverably_reorged: false }),
    indexHash: async () => (calls.push('indexHash'), hash),
    sat: async () => (calls.push('sat'), { number: 123, inscriptions: ids, address: 'holder', satpoint: txid + ':0:0' }),
    inscription: async (i) => {
      calls.push('inscription');
      const k = ids.indexOf(i);
      return { id: i, sat: 123, height: 10 + k, content_type: 'text/plain', content_length: length(), ...extra(k) };
    },
    content: async () => (calls.push('content'), new Uint8Array(length())),
    metadata: async () => (calls.push('metadata'), null),
  };
  return { reader, calls, ids };
}

describe('sat snapshot budgets (M1)', () => {
  test('the default request budget scales with the inscriptions the index lists', async () => {
    const { reader, calls } = memoryReader(150);
    const snapshot = await readSatSnapshot(reader, '123', 'regtest');
    expect(snapshot.publications).toHaveLength(150);
    expect(calls.length).toBeGreaterThan(512);
  });
  test('an explicit request budget is kept, and running out is incomplete evidence with a category', async () => {
    const { reader } = memoryReader(150);
    const refused = await readSatSnapshot(reader, '123', 'regtest', { maxRequests: 512 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OriginalsError);
    expect(refused).toMatchObject({ category: 'incomplete-evidence', code: 'SAT_SNAPSHOT_BUDGET_EXCEEDED' });
  });
  test('a sat listing more inscriptions than maxInscriptions is refused with a category, before reading them', async () => {
    const { reader, calls } = memoryReader(30);
    const refused = await readSatSnapshot(reader, '123', 'regtest', { maxInscriptions: 20 }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ category: 'incomplete-evidence', code: 'SAT_SNAPSHOT_TOO_MANY_INSCRIPTIONS' });
    expect(calls.includes('inscription')).toBe(false);
  });
  test('a body past the content-byte budget is observed unread; later bodies that fit are still read', async () => {
    const sizes = [600, 700, 100];
    let k = 0;
    const { reader, calls, ids } = memoryReader(3, () => ({}), () => sizes[k++]);
    const content = async (id: string) => (calls.push('content'), new Uint8Array(sizes[ids.indexOf(id)]));
    const snapshot = await readSatSnapshot({ ...reader, content }, '123', 'regtest', { maxContentBytes: 1000 });
    expect(snapshot.publications.map((p) => p.body.status)).toEqual(['complete', 'unavailable', 'complete']);
    expect(snapshot.publications[1].body).toEqual({ status: 'unavailable', reason: 'over-budget', mediaType: 'text/plain', contentLength: 700 });
    expect(calls.filter((c) => c === 'content')).toHaveLength(2);
  });
  test('errors at the seam carry a category', async () => {
    const { reader } = memoryReader(1);
    await expect(readSatSnapshot(reader, '123', 'mainnet')).rejects.toMatchObject({ category: 'invalid-evidence', code: 'SAT_SNAPSHOT_NETWORK_MISMATCH' });
    await expect(readSatSnapshot(reader, '123', 'regtest', { maxRequests: 0 })).rejects.toMatchObject({ category: 'invalid-evidence', code: 'SAT_SNAPSHOT_BUDGET_INVALID' });
    await expect(readSatSnapshot(reader, '123', 'regtest', { concurrency: 0 })).rejects.toMatchObject({ category: 'invalid-evidence', code: 'SAT_SNAPSHOT_BUDGET_INVALID' });
  });
});

const ORIGINALS = 'application/vnd.originals.vh+jsonl';
/**
 * An in-memory ord + Core for the holder's flooding attacks: `n` inscriptions
 * on sat 123, all in one block unless `spread`, each request taking `latency` ms.
 */
function floodReader(n: number, options: {
  latency?: number; info?: (k: number) => Record<string, unknown>; metadata?: (k: number) => unknown;
  content?: (k: number) => Promise<Uint8Array | null> | Uint8Array | null; spread?: boolean;
} = {}) {
  const ids = Array.from({ length: n }, (_, k) => `f${(k + 1).toString(16).padStart(63, '0')}i0`);
  const calls: string[] = [];
  let inFlight = 0, maxInFlight = 0;
  const heightOf = (k: number) => options.spread ? 10 + k : 10;
  const timed = async <T>(name: string, value: () => T | Promise<T>): Promise<T> => {
    calls.push(name);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.latency) await Bun.sleep(options.latency);
      return await value();
    } finally { inFlight--; }
  };
  const info = (k: number) => ({ content_type: 'text/plain', content_length: 1, ...options.info?.(k) });
  const reader: SatSnapshotReader = {
    rpc: (method, params) => timed(method, () => {
      if (method === 'getblockchaininfo') return { chain: 'regtest', blocks: 20_000, bestblockhash: hash };
      if (method === 'getblockhash') return (params[0] as number).toString(16).padStart(64, '0');
      const height = parseInt(params[0] as string, 16);
      return { hash: params[0], height, confirmations: 1, time: 1_700_000_000,
        tx: ids.filter((_, k) => heightOf(k) === height).map((i) => i.slice(0, 64)) };
    }),
    status: () => timed('status', () => ({ chain: 'regtest', height: 20_000, sat_index: true, inscription_index: true, unrecoverably_reorged: false })),
    indexHash: () => timed('indexHash', () => hash),
    sat: () => timed('sat', () => ({ number: 123, inscriptions: ids, address: 'holder', satpoint: txid + ':0:0' })),
    inscription: (i) => timed('inscription', () => {
      const k = ids.indexOf(i);
      return { id: i, sat: 123, height: heightOf(k), ...info(k) };
    }),
    content: (i) => timed('content', () => {
      const k = ids.indexOf(i);
      return options.content ? options.content(k) : new Uint8Array(info(k).content_length as number);
    }),
    metadata: (i) => timed('metadata', () => options.metadata ? options.metadata(ids.indexOf(i)) : null),
  };
  return { reader, calls, ids, maxInFlight: () => maxInFlight };
}

describe("the sat's holder cannot exhaust a read (P9.12, P9.17)", () => {
  test('hundreds of tiny reinscriptions do not run a default read out of time: the deadline scales and reads run concurrently', async () => {
    // 300 inscriptions x 3 reads x 40 ms is 36 s one at a time, past the old fixed 30 s deadline.
    const { reader, maxInFlight } = floodReader(300, { latency: 40 });
    const started = performance.now();
    const snapshot = await readSatSnapshot(reader, '123', 'regtest');
    expect(snapshot.publications).toHaveLength(300);
    expect(snapshot.publications.every((p) => p.body.status === 'complete')).toBe(true);
    expect(maxInFlight()).toBeLessThanOrEqual(8);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 60_000);

  test("an Originals asset read (bodies: 'originals') reads no body or metadata of other media types", async () => {
    const { reader, calls } = floodReader(5, { info: (k) => (k === 2 ? { content_type: ORIGINALS, content_length: 3 } : {}), metadata: () => 'a0' });
    const snapshot = await readSatSnapshot(reader, '123', 'regtest', {}, { bodies: 'originals' });
    expect(snapshot.bodies).toBe('originals');
    expect(calls.filter((c) => c === 'content')).toHaveLength(1);
    expect(calls.filter((c) => c === 'metadata')).toHaveLength(1);
    expect(snapshot.publications.map((p) => p.body.status)).toEqual(['unavailable', 'unavailable', 'complete', 'unavailable', 'unavailable']);
    expect(snapshot.publications[0].body).toEqual({ status: 'unavailable', reason: 'not-requested', mediaType: 'text/plain', contentLength: 1 });
    expect(snapshot.publications[2].body).toMatchObject({ status: 'complete', metadata: new Uint8Array([0xa0]) });
    // The default reads every body and its metadata: did:btco versions live in metadata (P5.13).
    const all = await readSatSnapshot(floodReader(5, { metadata: () => 'a0' }).reader, '123', 'regtest');
    expect(all.bodies).toBe('all');
    expect(all.publications.every((p) => p.body.status === 'complete' && p.body.metadata?.length === 1)).toBe(true);
  });

  test('a stalled request fails at its own timeout, not at the whole-read deadline', async () => {
    const { reader } = floodReader(3, { content: (k) => (k === 1 ? new Promise<Uint8Array>(() => {}) : new Uint8Array(1)) });
    const started = performance.now();
    await expect(readSatSnapshot(reader, '123', 'regtest', { requestTimeoutMs: 50 })).rejects.toMatchObject({ category: 'incomplete-evidence', code: 'SAT_SNAPSHOT_REQUEST_TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('metadata past 2.09 MB is read: hex is checked without a regular expression', async () => {
    const { reader } = floodReader(1, { metadata: () => '00'.repeat(2_200_000) });
    const snapshot = await readSatSnapshot(reader, '123', 'regtest');
    expect(snapshot.publications[0].body).toMatchObject({ status: 'complete' });
    expect((snapshot.publications[0].body as { metadata: Uint8Array }).metadata.length).toBe(2_200_000);
    await expect(readSatSnapshot(floodReader(1, { metadata: () => '0g' }).reader, '123', 'regtest')).rejects.toMatchObject({ code: 'SAT_SNAPSHOT_METADATA_UNAVAILABLE' });
  });

  test('metadata past the byte budget, or past the transport cap, is observed but unread, not a failed read', async () => {
    const over = await readSatSnapshot(floodReader(2, { metadata: (k) => (k === 0 ? '00'.repeat(2_000) : null) }).reader, '123', 'regtest', { maxContentBytes: 1_000 });
    expect(over.publications[0].body).toEqual({ status: 'unavailable', reason: 'over-budget', mediaType: 'text/plain', contentLength: 1, metadataPresent: true });
    expect(over.publications[1].body).toMatchObject({ status: 'complete' });
    const capped = await readSatSnapshot(floodReader(2, { metadata: (k) => { if (k === 0) throw new ResponseTooLargeError(1024); return null; } }).reader, '123', 'regtest');
    expect(capped.publications[0].body).toEqual({ status: 'unavailable', reason: 'over-budget', mediaType: 'text/plain', contentLength: 1, metadataPresent: true });
    const body = await readSatSnapshot(floodReader(2, { content: (k) => { if (k === 0) throw new ResponseTooLargeError(1024); return new Uint8Array(1); } }).reader, '123', 'regtest');
    expect(body.publications[0].body).toEqual({ status: 'unavailable', reason: 'over-budget', mediaType: 'text/plain', contentLength: 1 });
    expect(body.publications[1].body).toMatchObject({ status: 'complete' });
  });

  test('junk bodies cannot spend the budget an Originals inscription is read from', async () => {
    // Images before a small Originals inscription fill maxContentBytes exactly, then pass it.
    const sizes = (k: number) => (k < 6 ? 2_000 : 1_000);
    const { reader } = floodReader(7, { spread: true, info: (k) => ({ content_type: k < 6 ? 'image/png' : ORIGINALS, content_length: sizes(k) }) });
    const snapshot = await readSatSnapshot(reader, '123', 'regtest', { maxContentBytes: 10_000 });
    expect(snapshot.publications.map((p) => p.body.status)).toEqual(['complete', 'complete', 'complete', 'complete', 'complete', 'unavailable', 'complete']);
    expect(snapshot.publications[6].body).toMatchObject({ status: 'complete', mediaType: ORIGINALS });
  });

  test("C12-112: an Originals read does not read an Originals-typed body over 350,000 bytes; it is observed with its length", async () => {
    const { reader, calls } = floodReader(1, { info: () => ({ content_type: ORIGINALS, content_length: 400_000 }) });
    const snapshot = await readSatSnapshot(reader, '123', 'regtest', {}, { bodies: 'originals' });
    expect(snapshot.publications[0].body).toEqual({ status: 'unavailable', reason: 'over-budget', mediaType: ORIGINALS, contentLength: 400_000 });
    expect(calls.includes('content')).toBe(false);
  });
});
