import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QuickNodeProvider } from '../../../src/adapters/providers/QuickNodeProvider';
import { StructuredError } from '../../../src/utils/telemetry';

/**
 * QuickNodeProvider speaks JSON-RPC 2.0 against a single QuickNode endpoint:
 * ord_* methods for Ordinals & Runes API reads, standard Bitcoin Core RPC
 * (sendrawtransaction / getrawtransaction / estimatesmartfee) for the rest.
 * These tests mock fetch and assert both the request wire format and the
 * response mapping into the OrdinalsProvider contract.
 */

const ENDPOINT = 'https://example-name.btc.quiknode.pro/test-token/';
const INSCRIPTION_ID = 'a860baeecae8c2d9fb95f09608d3b3e2bbaf207f25a6361e0d07a326906f8be6i0';
const TXID = 'a860baeecae8c2d9fb95f09608d3b3e2bbaf207f25a6361e0d07a326906f8be6';

type RpcRequest = { method: string; params: unknown[]; id: number; jsonrpc: string };

interface MockRoute {
  match: (req: RpcRequest) => boolean;
  respond: (req: RpcRequest) => { status?: number; body?: unknown; headers?: Record<string, string> };
}

let requests: RpcRequest[];
let routes: MockRoute[];
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mockRpc(method: string, result: unknown): void {
  routes.push({ match: (r) => r.method === method, respond: () => ({ body: { jsonrpc: '2.0', id: 1, result } }) });
}

function mockRpcError(method: string, error: { code?: number; message: string }): void {
  routes.push({ match: (r) => r.method === method, respond: () => ({ body: { jsonrpc: '2.0', id: 1, result: null, error } }) });
}

beforeEach(() => {
  requests = [];
  routes = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const req = JSON.parse(String(init?.body ?? '{}')) as RpcRequest;
    requests.push(req);
    const route = routes.find((r) => r.match(req));
    if (!route) {
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: null, error: { code: -32601, message: `Method not found: ${req.method}` } });
    }
    const { status = 200, body, headers = {} } = route.respond(req);
    return jsonResponse(body, status, headers);
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('QuickNodeProvider constructor', () => {
  test('requires an endpoint', () => {
    expect(() => new QuickNodeProvider({ endpoint: '' })).toThrow(StructuredError);
  });

  test('rejects a malformed endpoint URL', () => {
    expect(() => new QuickNodeProvider({ endpoint: 'not-a-url' })).toThrow(/not a valid URL/);
  });

  test('rejects non-http(s) protocols', () => {
    expect(() => new QuickNodeProvider({ endpoint: 'ftp://example.com/' })).toThrow(/must be http/);
  });
});

describe('getInscriptionById', () => {
  const provider = () => new QuickNodeProvider({ endpoint: ENDPOINT });

  test('maps ord_getInscription + ord_getContent into the provider contract', async () => {
    mockRpc('ord_getInscription', {
      id: INSCRIPTION_ID,
      number: 12345,
      sat: 125866034480298,
      satpoint: `${TXID}:0:0`,
      content_type: 'text/plain;charset=utf-8',
      content_length: 5,
      height: 767430,
      value: 10000,
      address: 'bc1pexample',
    });
    mockRpc('ord_getContent', Buffer.from('hello', 'utf8').toString('base64'));

    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect(result).not.toBeNull();
    expect(result!.inscriptionId).toBe(INSCRIPTION_ID);
    expect(result!.content.toString('utf8')).toBe('hello');
    expect(result!.contentType).toBe('text/plain;charset=utf-8');
    expect(result!.txid).toBe(TXID);
    expect(result!.vout).toBe(0);
    expect(result!.satoshi).toBe('125866034480298');
    expect(result!.blockHeight).toBe(767430);

    // Wire format: JSON-RPC 2.0 with the inscription id as sole param
    expect(requests[0]).toMatchObject({ jsonrpc: '2.0', method: 'ord_getInscription', params: [INSCRIPTION_ID] });
    expect(requests[1]).toMatchObject({ jsonrpc: '2.0', method: 'ord_getContent', params: [INSCRIPTION_ID] });
  });

  test('parses vout from a non-zero satpoint', async () => {
    mockRpc('ord_getInscription', { id: INSCRIPTION_ID, sat: 1, satpoint: `${TXID}:3:512`, content_type: 'text/plain' });
    mockRpc('ord_getContent', Buffer.from('x').toString('base64'));
    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect(result!.txid).toBe(TXID);
    expect(result!.vout).toBe(3);
  });

  test('keeps a short base64-shaped text inscription literal ("text" stays "text")', async () => {
    mockRpc('ord_getInscription', { id: INSCRIPTION_ID, sat: 1, satpoint: `${TXID}:0:0`, content_type: 'text/plain;charset=utf-8' });
    // "text" passes the base64 charset/length checks but decodes to invalid
    // UTF-8 — for a text-typed inscription it must be kept as the literal string.
    mockRpc('ord_getContent', 'text');
    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect(result!.content.toString('utf8')).toBe('text');
  });

  test('base64-decodes text content when the decoded bytes are valid UTF-8', async () => {
    mockRpc('ord_getInscription', { id: INSCRIPTION_ID, sat: 1, satpoint: `${TXID}:0:0`, content_type: 'text/plain' });
    mockRpc('ord_getContent', Buffer.from('hello world', 'utf8').toString('base64'));
    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect(result!.content.toString('utf8')).toBe('hello world');
  });

  test('always base64-decodes binary content types, even short strings', async () => {
    mockRpc('ord_getInscription', { id: INSCRIPTION_ID, sat: 1, satpoint: `${TXID}:0:0`, content_type: 'image/png' });
    // 'text' as base64 decodes to bytes b5 eb 2d — a binary inscription must
    // never be kept as the literal string.
    mockRpc('ord_getContent', 'text');
    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect([...result!.content]).toEqual([...Buffer.from('text', 'base64')]);
  });

  test('propagates auth/routing errors that merely contain "not found"', async () => {
    mockRpcError('ord_getInscription', { code: -32000, message: 'API key not found' });
    await expect(provider().getInscriptionById(INSCRIPTION_ID)).rejects.toThrow(/API key not found/);
  });

  test('propagates endpoint routing errors containing "not found"', async () => {
    mockRpcError('ord_getInscription', { code: -32601, message: 'Endpoint not found in routing table' });
    await expect(provider().getInscriptionById(INSCRIPTION_ID)).rejects.toThrow(/routing table/);
  });

  test('treats non-base64 content as literal UTF-8 text', async () => {
    mockRpc('ord_getInscription', { id: INSCRIPTION_ID, sat: 1, satpoint: `${TXID}:0:0`, content_type: 'text/plain' });
    // '{"p":"x"}' is not valid base64 (contains '{', '"', ':')
    mockRpc('ord_getContent', '{"p":"x"}');
    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect(result!.content.toString('utf8')).toBe('{"p":"x"}');
  });

  test('unwraps object-shaped content results', async () => {
    mockRpc('ord_getInscription', { id: INSCRIPTION_ID, sat: 1, satpoint: `${TXID}:0:0`, content_type: 'image/png' });
    mockRpc('ord_getContent', { content: Buffer.from([1, 2, 3]).toString('base64') });
    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect([...result!.content]).toEqual([1, 2, 3]);
  });

  test('returns null when the inscription is not found', async () => {
    mockRpcError('ord_getInscription', { code: -32000, message: 'inscription not found' });
    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect(result).toBeNull();
  });

  test('returns null for an empty id without any RPC call', async () => {
    const result = await provider().getInscriptionById('');
    expect(result).toBeNull();
    expect(requests.length).toBe(0);
  });

  test('omits satoshi when the sat is unindexed (null)', async () => {
    mockRpc('ord_getInscription', { id: INSCRIPTION_ID, sat: null, satpoint: `${TXID}:0:0`, content_type: 'text/plain' });
    mockRpc('ord_getContent', Buffer.from('x').toString('base64'));
    const result = await provider().getInscriptionById(INSCRIPTION_ID);
    expect(result!.satoshi).toBeUndefined();
  });

  test('propagates transport-level RPC failures', async () => {
    mockRpcError('ord_getInscription', { code: -32603, message: 'internal error' });
    await expect(provider().getInscriptionById(INSCRIPTION_ID)).rejects.toThrow(/internal error/);
  });

  test('rejects inscription content exceeding maxContentBytes', async () => {
    const small = new QuickNodeProvider({ endpoint: ENDPOINT, maxContentBytes: 4 });
    mockRpc('ord_getInscription', { id: INSCRIPTION_ID, sat: 1, satpoint: `${TXID}:0:0`, content_type: 'text/plain' });
    mockRpc('ord_getContent', Buffer.from('hello world', 'utf8').toString('base64'));
    await expect(small.getInscriptionById(INSCRIPTION_ID)).rejects.toThrow(/exceeds 4 bytes/);
  });
});

describe('getInscriptionsBySatoshi', () => {
  const provider = () => new QuickNodeProvider({ endpoint: ENDPOINT });

  test('sends the sat as a JSON number and maps the inscriptions array', async () => {
    mockRpc('ord_getSat', { number: 125866034480298, rarity: 'common', inscriptions: [INSCRIPTION_ID, 'otherI0id'] });
    const result = await provider().getInscriptionsBySatoshi('125866034480298');
    expect(result).toEqual([{ inscriptionId: INSCRIPTION_ID }, { inscriptionId: 'otherI0id' }]);
    expect(requests[0]).toMatchObject({ method: 'ord_getSat', params: [125866034480298] });
  });

  test('supports the inscription_ids response shape', async () => {
    mockRpc('ord_getSat', { inscription_ids: [INSCRIPTION_ID] });
    const result = await provider().getInscriptionsBySatoshi('123');
    expect(result).toEqual([{ inscriptionId: INSCRIPTION_ID }]);
  });

  test('returns [] when the sat has no inscriptions', async () => {
    mockRpc('ord_getSat', { number: 123, rarity: 'common', inscriptions: [] });
    const result = await provider().getInscriptionsBySatoshi('123');
    expect(result).toEqual([]);
  });

  test('propagates auth errors containing "not found" instead of returning []', async () => {
    mockRpcError('ord_getSat', { code: -32000, message: 'API key not found' });
    await expect(provider().getInscriptionsBySatoshi('123')).rejects.toThrow(/API key not found/);
  });

  test('returns [] for an ord-style "sat not found" error', async () => {
    mockRpcError('ord_getSat', { code: -32000, message: 'sat not found' });
    const result = await provider().getInscriptionsBySatoshi('123');
    expect(result).toEqual([]);
  });

  test('rejects invalid satoshi identifiers without any RPC call', async () => {
    await expect(provider().getInscriptionsBySatoshi('sat-123')).rejects.toThrow(StructuredError);
    await expect(provider().getInscriptionsBySatoshi('')).rejects.toThrow(StructuredError);
    expect(requests.length).toBe(0);
  });

  test('rejects satoshi numbers above max supply', async () => {
    await expect(provider().getInscriptionsBySatoshi('2100000000000000')).rejects.toThrow(StructuredError);
    expect(requests.length).toBe(0);
  });
});

describe('broadcastTransaction', () => {
  const provider = () => new QuickNodeProvider({ endpoint: ENDPOINT });

  test('submits raw hex via sendrawtransaction and returns the txid', async () => {
    mockRpc('sendrawtransaction', TXID);
    const txid = await provider().broadcastTransaction('0200aabb');
    expect(txid).toBe(TXID);
    expect(requests[0]).toMatchObject({ method: 'sendrawtransaction', params: ['0200aabb'] });
  });

  test('rejects non-hex input up front', async () => {
    await expect(provider().broadcastTransaction('not-hex')).rejects.toThrow(/hex/);
    await expect(provider().broadcastTransaction('abc')).rejects.toThrow(/hex/); // odd length
    await expect(provider().broadcastTransaction({ tx: 'obj' })).rejects.toThrow(/hex/);
    expect(requests.length).toBe(0);
  });

  test('surfaces RPC rejection (e.g. mempool rejection)', async () => {
    mockRpcError('sendrawtransaction', { code: -26, message: 'min relay fee not met' });
    await expect(provider().broadcastTransaction('0200aabb')).rejects.toThrow(/min relay fee not met/);
  });

  test('refuses an empty txid result instead of reporting success', async () => {
    mockRpc('sendrawtransaction', '');
    await expect(provider().broadcastTransaction('0200aabb')).rejects.toThrow(/no txid/);
  });
});

describe('getTransactionStatus', () => {
  const provider = () => new QuickNodeProvider({ endpoint: ENDPOINT });
  const BLOCKHASH = '00000000000000000002b1c2f0dcb8f1f4a1e6d3c9a7b5e8d2f4a6c8e0b2d4f6';

  test('reports a confirmed transaction with height from getblockheader', async () => {
    mockRpc('getrawtransaction', { txid: TXID, confirmations: 3, blockhash: BLOCKHASH });
    mockRpc('getblockheader', { hash: BLOCKHASH, height: 800000 });
    const status = await provider().getTransactionStatus(TXID);
    expect(status).toEqual({ confirmed: true, confirmations: 3, blockHeight: 800000 });
    expect(requests[0]).toMatchObject({ method: 'getrawtransaction', params: [TXID, true] });
    expect(requests[1]).toMatchObject({ method: 'getblockheader', params: [BLOCKHASH, true] });
  });

  test('still reports confirmed when getblockheader fails', async () => {
    mockRpc('getrawtransaction', { txid: TXID, confirmations: 2, blockhash: BLOCKHASH });
    mockRpcError('getblockheader', { code: -32603, message: 'boom' });
    const status = await provider().getTransactionStatus(TXID);
    expect(status.confirmed).toBe(true);
    expect(status.confirmations).toBe(2);
    expect(status.blockHeight).toBeUndefined();
  });

  test('reports a mempool transaction as unconfirmed', async () => {
    mockRpc('getrawtransaction', { txid: TXID, confirmations: 0 });
    const status = await provider().getTransactionStatus(TXID);
    expect(status).toEqual({ confirmed: false, confirmations: 0 });
  });

  test('treats RPC -5 (unknown tx) as unconfirmed rather than an error', async () => {
    mockRpcError('getrawtransaction', { code: -5, message: 'No such mempool or blockchain transaction' });
    const status = await provider().getTransactionStatus(TXID);
    expect(status).toEqual({ confirmed: false });
  });

  test('rejects malformed txids without any RPC call', async () => {
    await expect(provider().getTransactionStatus('nope')).rejects.toThrow(StructuredError);
    expect(requests.length).toBe(0);
  });

  test('propagates transport-level failures', async () => {
    mockRpcError('getrawtransaction', { code: -32603, message: 'internal error' });
    await expect(provider().getTransactionStatus(TXID)).rejects.toThrow(/internal error/);
  });
});

describe('estimateFee', () => {
  const provider = () => new QuickNodeProvider({ endpoint: ENDPOINT });

  test('converts BTC/kvB to sat/vB, rounding up', async () => {
    mockRpc('estimatesmartfee', { feerate: 0.00012345, blocks: 2 });
    const fee = await provider().estimateFee(2);
    expect(fee).toBe(13); // 0.00012345 * 1e5 = 12.345 → ceil → 13
    expect(requests[0]).toMatchObject({ method: 'estimatesmartfee', params: [2] });
  });

  test('defaults to a 1-block target and clamps to a minimum of 1 sat/vB', async () => {
    mockRpc('estimatesmartfee', { feerate: 0.00000001 });
    const fee = await provider().estimateFee();
    expect(fee).toBe(1);
    expect(requests[0]).toMatchObject({ params: [1] });
  });

  test('fails loudly instead of inventing a rate when the node has no fee data', async () => {
    mockRpc('estimatesmartfee', { errors: ['Insufficient data or no feerate found'] });
    await expect(provider().estimateFee(1)).rejects.toThrow(/no feerate/);
    await expect(provider().estimateFee(1)).rejects.toThrow(/Insufficient data/);
  });
});

describe('write-path methods fail loudly instead of fabricating', () => {
  const provider = () => new QuickNodeProvider({ endpoint: ENDPOINT });

  test('createInscription rejects with a NOT_IMPLEMENTED StructuredError and no RPC call', async () => {
    const err = await provider()
      .createInscription({ data: Buffer.from('x'), contentType: 'text/plain' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StructuredError);
    expect((err as StructuredError).code).toBe('QUICKNODE_CREATE_INSCRIPTION_NOT_IMPLEMENTED');
    expect(requests.length).toBe(0);
  });

  test('transferInscription rejects with a NOT_IMPLEMENTED StructuredError and no RPC call', async () => {
    const err = await provider()
      .transferInscription(INSCRIPTION_ID, 'bc1pexample')
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StructuredError);
    expect((err as StructuredError).code).toBe('QUICKNODE_TRANSFER_NOT_IMPLEMENTED');
    expect(requests.length).toBe(0);
  });
});

describe('response hardening', () => {
  test('rejects oversized JSON-RPC responses', async () => {
    const provider = new QuickNodeProvider({ endpoint: ENDPOINT, maxJsonBytes: 32 });
    mockRpc('ord_getSat', { inscriptions: [], padding: 'x'.repeat(256) });
    await expect(provider.getInscriptionsBySatoshi('123')).rejects.toThrow(/exceeds 32 bytes/);
  });

  test('surfaces HTTP failures with non-JSON bodies as an RPC HTTP error', async () => {
    globalThis.fetch = (async () => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })) as any;
    const provider = new QuickNodeProvider({ endpoint: ENDPOINT });
    await expect(provider.estimateFee(1)).rejects.toThrow(/HTTP 502/);
  });

  test('parses RPC error bodies delivered with non-2xx status (bitcoind style)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null, error: { code: -26, message: 'txn-mempool-conflict' } }), { status: 500 })
    ) as any;
    const provider = new QuickNodeProvider({ endpoint: ENDPOINT });
    await expect(provider.broadcastTransaction('0200aabb')).rejects.toThrow(/txn-mempool-conflict/);
  });
});
