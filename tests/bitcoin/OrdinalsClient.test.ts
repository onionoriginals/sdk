import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';
import { encode as cborEncode } from '../../src/utils/cbor';

const client = new OrdinalsClient('http://localhost:3000', 'regtest');

describe('OrdinalsClient (real HTTP behavior with mocked fetch)', () => {
  const json = (data: any, ok = true) => ({ ok, json: async () => data });
  const bin = (bytes: Uint8Array, ok = true) => ({ ok, arrayBuffer: async () => bytes.buffer });

  beforeEach(() => {
    jest.spyOn(global, 'fetch' as any).mockImplementation(async (input: any) => {
      const url = String(input);
      // sat info
      if (url.endsWith('/sat/123')) {
        return json({ data: { inscription_ids: ['insc-123', 'insc-456'] } });
      }
      if (url.endsWith('/sat/direct')) {
        return json({ inscription_ids: [] });
      }
      if (url.endsWith('/sat/nonarray')) {
        return json({ data: { inscription_ids: 'oops' } });
      }
      if (url.endsWith('/sat/0')) {
        return { ok: false, json: async () => ({}) } as any; // triggers empty path
      }

      // inscription info
      if (url.endsWith('/inscription/insc-777')) {
        return json({
          data: {
            inscription_id: 'insc-777',
            content_type: 'text/plain',
            content_url: 'http://localhost:3000/content/insc-777',
            sat: 777,
            owner_output: 'tx777:1',
            block_height: 1234
          }
        });
      }
      if (url.endsWith('/inscription/insc-404')) {
        return { ok: false, json: async () => ({}) } as any;
      }
      if (url.endsWith('/inscription/insc-123')) {
        return json({
          data: {
            inscription_id: 'insc-123',
            content_type: 'text/plain',
            content_url: 'http://localhost:3000/content/insc-123',
            sat: 123,
            owner_output: 'tx123:0'
          }
        });
      }
      if (url.endsWith('/inscription/insc-456')) {
        return json({
          data: {
            inscription_id: 'insc-456',
            content_type: 'text/plain',
            content_url: 'http://localhost:3000/content/insc-456',
            sat: 456,
            owner_output: 'tx456:0'
          }
        });
      }
      if (url.endsWith('/inscription/insc-888')) {
        return json({
          data: {
            inscription_id: 'insc-888',
            content_type: 'text/plain',
            content_url: 'http://localhost:3000/content/insc-888',
            sat: 888,
            owner_output: 'tx888:2'
          }
        });
      }
      if (url.endsWith('/inscription/insc-nosat')) {
        return json({
          data: {
            // missing sat on purpose
            inscription_id: 'insc-nosat',
            content_type: 'text/plain',
            content_url: 'http://localhost:3000/content/insc-nosat',
            owner_output: 'txns:0'
          }
        });
      }
      if (url.endsWith('/inscription/insc-no-id')) {
        return json({
          data: {
            // missing inscription_id to trigger identifier fallback
            content_type: 'text/plain',
            content_url: 'http://localhost:3000/content/insc-no-id',
            sat: 55,
            owner_output: 'txnid:0'
          }
        });
      }
      if (url.endsWith('/inscription/insc-fail-content')) {
        return json({
          data: {
            inscription_id: 'insc-fail-content',
            content_type: 'text/plain',
            content_url: 'http://localhost:3000/content/insc-fail-content',
            sat: 1,
            owner_output: 'badformat' // no colon
          }
        });
      }
      if (url.endsWith('/inscription/insc-no-content-url')) {
        return json({
          data: {
            inscription_id: 'insc-no-content-url',
            content_type: 'text/plain',
            sat: 2
          }
        });
      }
      if (url.endsWith('/inscription/insc-no-content-type')) {
        return json({
          data: {
            inscription_id: 'insc-no-content-type',
            // content_type omitted to trigger default path
            content_url: 'http://localhost:3000/content/insc-no-content-type',
            sat: 3,
            owner_output: 'txnct:0'
          }
        });
      }
      if (url.endsWith('/inscription/insc-metadata-object')) {
        return json({
          data: {
            inscription_id: 'insc-metadata-object',
            content_type: 'application/json',
            content_url: 'http://localhost:3000/content/insc-metadata-object',
            sat: 42,
            owner_output: 'tx:0',
            metadata: { id: 'insc-metadata-object', test: true }
          }
        });
      }
      if (url.endsWith('/inscription/insc-metadata-hex')) {
        const obj = { id: 'insc-metadata-hex', ok: 1 };
        const hex = Buffer.from(cborEncode(obj)).toString('hex');
        return json({
          data: {
            inscription_id: 'insc-metadata-hex',
            content_type: 'application/cbor',
            content_url: 'http://localhost:3000/content/insc-metadata-hex',
            sat: 99,
            owner_output: 'tx:0',
            metadata: hex
          }
        });
      }
      if (url.endsWith('/inscription/insc-metadata-hex0x')) {
        const obj = { id: 'insc-metadata-hex0x', ok: true };
        const hex = '0x' + Buffer.from(cborEncode(obj)).toString('hex');
        return json({
          data: {
            content_type: 'application/cbor',
            content_url: 'http://localhost:3000/content/insc-metadata-hex0x',
            sat: 101,
            owner_output: 'tx:0',
            metadata: hex
          }
        });
      }
      if (url.endsWith('/inscription/insc-hex-invalid')) {
        return json({
          data: {
            inscription_id: 'insc-hex-invalid',
            content_type: 'application/cbor',
            content_url: 'http://localhost:3000/content/insc-hex-invalid',
            sat: 5,
            owner_output: 'tx:0',
            metadata: 'zz' // invalid hex
          }
        });
      }
      if (url.endsWith('/inscription/insc-hex-odd')) {
        return json({
          data: {
            inscription_id: 'insc-hex-odd',
            content_type: 'text/plain',
            content_url: 'http://localhost:3000/content/insc-hex-odd',
            sat: 7,
            owner_output: 'tx:0',
            metadata: 'f' // odd-length
          }
        });
      }
      if (url.endsWith('/inscription/insc-m-noinfo')) {
        return { ok: false, json: async () => ({}) } as any;
      }
      if (url.endsWith('/inscription/insc-cbor-fetch-fail')) {
        return json({
          data: {
            inscription_id: 'insc-cbor-fetch-fail',
            content_type: 'application/cbor',
            content_url: 'http://localhost:3000/content/insc-cbor-fetch-fail',
            sat: 8,
            owner_output: 'tx:0'
          }
        });
      }
      if (url.endsWith('/inscription/insc-metadata-cbor-content')) {
        return json({
          data: {
            inscription_id: 'insc-metadata-cbor-content',
            content_type: 'application/cbor',
            content_url: 'http://localhost:3000/content/insc-metadata-cbor-content',
            sat: 100,
            owner_output: 'tx:0'
          }
        });
      }
      if (url.endsWith('/inscription/insc-cbor-no-content-url')) {
        return json({
          data: {
            inscription_id: 'insc-cbor-no-content-url',
            content_type: 'application/cbor',
            sat: 150,
            owner_output: 'tx:0'
          }
        });
      }

      // content bytes
      if (url.endsWith('/content/insc-777')) {
        return bin(new Uint8Array([1, 2, 3]));
      }
      if (url.endsWith('/content/insc-888')) {
        return bin(new Uint8Array([4, 5]));
      }
      if (url.endsWith('/content/insc-123')) {
        return bin(new Uint8Array([10]));
      }
      if (url.endsWith('/content/insc-456')) {
        return bin(new Uint8Array([11]));
      }
      if (url.endsWith('/content/insc-nosat')) {
        return bin(new Uint8Array([12]));
      }
      if (url.endsWith('/content/insc-no-id')) {
        return bin(new Uint8Array([13]));
      }
      if (url.endsWith('/content/insc-fail-content')) {
        return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) } as any;
      }
      if (url.endsWith('/content/insc-no-content-url')) {
        return bin(new Uint8Array([7, 7]));
      }
      if (url.endsWith('/content/insc-no-content-type')) {
        return bin(new Uint8Array([8, 8]));
      }
      if (url.endsWith('/content/insc-metadata-object')) {
        return bin(new Uint8Array([0]));
      }
      if (url.endsWith('/content/insc-metadata-hex')) {
        return bin(new Uint8Array([9]));
      }
      if (url.endsWith('/content/insc-metadata-cbor-content')) {
        const obj = { fromContent: true };
        return bin(cborEncode(obj));
      }
      if (url.endsWith('/content/insc-hex-invalid')) {
        const obj = { fromContentFallback: true };
        return bin(cborEncode(obj));
      }
      if (url.endsWith('/content/insc-hex-odd')) {
        // not used since content_type is text/plain; but provide ok anyway
        return bin(new Uint8Array([1]));
      }
      if (url.endsWith('/content/insc-cbor-fetch-fail')) {
        return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) } as any;
      }
      if (url.endsWith('/content/insc-cbor-no-content-url')) {
        const obj = { fromContentFallbackRpcUrl: true };
        return bin(cborEncode(obj));
      }

      return json({}, false) as any;
    });
  });

  afterEach(() => {
    (global.fetch as any).mockRestore?.();
  });

  test('getInscriptionById returns inscription via HTTP', async () => {
    const insc = await client.getInscriptionById('insc-777');
    expect(insc).toEqual(
      expect.objectContaining({ inscriptionId: 'insc-777', contentType: 'text/plain', txid: 'tx777', vout: 1 })
    );
  });

  test('getInscriptionById returns null on 404 info', async () => {
    const insc = await client.getInscriptionById('insc-404');
    expect(insc).toBeNull();
  });

  test('getInscriptionById returns null for empty id', async () => {
    const insc = await client.getInscriptionById('');
    expect(insc).toBeNull();
  });

  test('getInscriptionsBySatoshi fetches ids then resolves each', async () => {
    const list = await client.getInscriptionsBySatoshi('123');
    expect(list.length).toBe(2);
    expect(list[0].inscriptionId).toBe('insc-123');
  });

  test('getInscriptionsBySatoshi returns empty when sat has no inscriptions', async () => {
    const list = await client.getInscriptionsBySatoshi('0');
    expect(list).toEqual([]);
  });

  test('broadcastTransaction returns txid (still a thin wrapper)', async () => {
    await expect(client.broadcastTransaction({ txid: 't', vin: [], vout: [], fee: 0 })).resolves.toEqual('t');
  });

  test('broadcastTransaction falls back when txid missing', async () => {
    // @ts-ignore
    await expect(client.broadcastTransaction({ vin: [], vout: [], fee: 0 })).resolves.toEqual('txid');
  });

  test('getTransactionStatus returns status (placeholder)', async () => {
    const status = await client.getTransactionStatus('txid');
    expect(status.confirmed).toBeDefined();
  });

  test('estimateFee returns a number and clamps floor', async () => {
    await expect(client.estimateFee(1)).resolves.toEqual(expect.any(Number));
    await expect(client.estimateFee()).resolves.toEqual(expect.any(Number));
    await expect(client.estimateFee(0)).resolves.toBeGreaterThanOrEqual(10);
  });

  test('getSatInfo returns ids when available and empty on 404', async () => {
    const info = await client.getSatInfo('123');
    expect(info.inscription_ids).toEqual(['insc-123', 'insc-456']);
    const empty = await client.getSatInfo('0');
    expect(empty.inscription_ids).toEqual([]);
    const direct = await client.getSatInfo('direct');
    expect(direct.inscription_ids).toEqual([]);
    const nonarray = await client.getSatInfo('nonarray');
    expect(nonarray.inscription_ids).toEqual([]);
  });

  test('resolveInscription returns mapped inscription with content bytes', async () => {
    const insc = await client.resolveInscription('insc-888');
    expect(insc).toEqual(expect.objectContaining({ inscriptionId: 'insc-888', txid: 'tx888', vout: 2 }));
    expect(insc!.content).toBeInstanceOf(Buffer);
    expect(insc!.content.length).toBe(2);
  });

  test('resolveInscription handles missing colon in owner_output and failed content fetch', async () => {
    await expect(client.resolveInscription('insc-fail-content')).rejects.toThrow('Failed to fetch inscription content');
  });

  test('resolveInscription falls back to default content url when not provided', async () => {
    const insc = await client.resolveInscription('insc-no-content-url');
    expect(insc).toEqual(expect.objectContaining({ inscriptionId: 'insc-no-content-url' }));
    expect(insc!.content.length).toBe(2);
  });

  test('resolveInscription defaults contentType when missing', async () => {
    const insc = await client.resolveInscription('insc-no-content-type');
    expect(insc!.contentType).toBe('application/octet-stream');
    expect(insc!.content.length).toBe(2);
  });

  test('resolveInscription stringifies missing sat and falls back id when missing', async () => {
    const missingSat = await client.resolveInscription('insc-nosat');
    expect(missingSat!.satoshi).toBe('');
    const missingId = await client.resolveInscription('insc-no-id');
    expect(missingId!.inscriptionId).toBe('insc-no-id');
  });

  test('getMetadata prefers metadata object from API', async () => {
    const meta = await client.getMetadata('insc-metadata-object');
    expect(meta).toEqual(expect.objectContaining({ id: 'insc-metadata-object', test: true }));
  });

  test('getMetadata decodes hex CBOR when provided', async () => {
    const meta = await client.getMetadata('insc-metadata-hex');
    expect(meta).toEqual(expect.objectContaining({ id: 'insc-metadata-hex', ok: 1 }));
  });

  test('getMetadata decodes 0x-prefixed hex CBOR', async () => {
    const meta = await client.getMetadata('insc-metadata-hex0x');
    expect(meta).toEqual(expect.objectContaining({ id: 'insc-metadata-hex0x', ok: true }));
  });

  test('getMetadata ignores invalid hex and returns null unless content is CBOR', async () => {
    const meta = await client.getMetadata('insc-hex-invalid');
    // content_type is application/cbor in info, so it should fallback to content fetch and decode
    expect(meta).toEqual(expect.objectContaining({ fromContentFallback: true }));
  });

  test('getMetadata ignores odd-length hex and returns null for non-cbor type', async () => {
    const meta = await client.getMetadata('insc-hex-odd');
    expect(meta).toBeNull();
  });

  test('getMetadata content fetch fail path returns null', async () => {
    const meta = await client.getMetadata('insc-cbor-fetch-fail');
    expect(meta).toBeNull();
  });

  test('getMetadata returns null when info endpoint not ok', async () => {
    const meta = await client.getMetadata('insc-m-noinfo');
    expect(meta).toBeNull();
  });

  test('getMetadata falls back to fetching CBOR content when type is application/cbor', async () => {
    const meta = await client.getMetadata('insc-metadata-cbor-content');
    expect(meta).toEqual(expect.objectContaining({ fromContent: true }));
  });

  test('getMetadata uses rpcUrl/content when content_url missing and content_type is CBOR', async () => {
    const meta = await client.getMetadata('insc-cbor-no-content-url');
    expect(meta).toEqual(expect.objectContaining({ fromContentFallbackRpcUrl: true }));
  });

  test('resolveInscription returns null for empty identifier', async () => {
    const insc = await client.resolveInscription('');
    expect(insc).toBeNull();
  });

  test('getMetadata returns null for empty id', async () => {
    const meta = await client.getMetadata('');
    expect(meta).toBeNull();
  });
});


