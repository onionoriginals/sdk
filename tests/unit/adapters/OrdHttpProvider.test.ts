import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { OrdHttpProvider, createOrdinalsProviderFromEnv } from '../../../src/adapters/providers/OrdHttpProvider';

describe('OrdHttpProvider', () => {
  let fetchSpy: any;
  let originalFetch: any;
  let originalBuffer: any;

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
    originalBuffer = (globalThis as any).Buffer;
    (globalThis as any).Buffer = Buffer;
  });

  afterEach(() => {
    if (fetchSpy) {
      fetchSpy.mockRestore();
    }
    if (originalFetch !== undefined) {
      (globalThis as any).fetch = originalFetch;
    }
    if (originalBuffer !== undefined) {
      (globalThis as any).Buffer = originalBuffer;
    }
  });

  describe('constructor', () => {
    test('throws error when baseUrl is missing', () => {
      expect(() => new OrdHttpProvider({} as any)).toThrow('OrdHttpProvider requires baseUrl');
    });

    test('throws error when options is undefined', () => {
      expect(() => new OrdHttpProvider(undefined as any)).toThrow('OrdHttpProvider requires baseUrl');
    });

    test('creates instance with valid baseUrl', () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      expect(provider).toBeDefined();
    });
  });

  describe('getInscriptionById', () => {
    test('returns null for empty id', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.getInscriptionById('');
      expect(result).toBeNull();
    });

    test('returns null when fetch fails', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      fetchSpy = spyOn(globalThis as any, 'fetch').mockResolvedValue({
        ok: false,
        status: 404
      });

      const result = await provider.getInscriptionById('test-id');
      expect(result).toBeNull();
    });

    test('returns null when content fetch fails', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      let callCount = 0;
      fetchSpy = spyOn(globalThis as any, 'fetch').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: inscription metadata
          return {
            ok: true,
            json: async () => ({
              inscription_id: 'test-id',
              content_type: 'text/plain',
              txid: 'abc123',
              vout: 0
            })
          };
        }
        // Second call: content fetch fails
        return { ok: false, status: 404 };
      });

      const result = await provider.getInscriptionById('test-id');
      expect(result).toBeNull();
    });

    test('fetches inscription with owner_output format', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com/' });
      let callCount = 0;
      fetchSpy = spyOn(globalThis as any, 'fetch').mockImplementation(async (url: string) => {
        callCount++;
        if (callCount === 1) {
          // Metadata fetch
          expect(url).toBe('https://api.example.com/inscription/insc123');
          return {
            ok: true,
            json: async () => ({
              inscription_id: 'insc123',
              owner_output: 'txid456:2',
              content_type: 'image/png',
              sat: 100000,
              block_height: 800000
            })
          };
        }
        // Content fetch
        expect(url).toBe('https://api.example.com/content/insc123');
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
        };
      });

      const result = await provider.getInscriptionById('insc123');
      expect(result).not.toBeNull();
      expect(result?.inscriptionId).toBe('insc123');
      expect(result?.txid).toBe('txid456');
      expect(result?.vout).toBe(2);
      expect(result?.contentType).toBe('image/png');
      expect(result?.satoshi).toBe('100000');
      expect(result?.blockHeight).toBe(800000);
      expect(Buffer.isBuffer(result?.content)).toBe(true);
    });

    test('fetches inscription with txid/vout fields', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      let callCount = 0;
      fetchSpy = spyOn(globalThis as any, 'fetch').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              inscription_id: 'insc789',
              txid: 'direct-txid',
              vout: 3,
              content_type: 'text/html'
            })
          };
        }
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([5, 6, 7]).buffer
        };
      });

      const result = await provider.getInscriptionById('insc789');
      expect(result).not.toBeNull();
      expect(result?.txid).toBe('direct-txid');
      expect(result?.vout).toBe(3);
    });

    test('uses default values for missing fields', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      let callCount = 0;
      fetchSpy = spyOn(globalThis as any, 'fetch').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              // Minimal data
            })
          };
        }
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([]).buffer
        };
      });

      const result = await provider.getInscriptionById('minimal-id');
      expect(result).not.toBeNull();
      expect(result?.contentType).toBe('application/octet-stream');
      expect(result?.txid).toBe('unknown');
      expect(result?.vout).toBe(0);
      expect(result?.satoshi).toBe('');
    });

    test('uses custom content_url if provided', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      let callCount = 0;
      fetchSpy = spyOn(globalThis as any, 'fetch').mockImplementation(async (url: string) => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              inscription_id: 'test-id',
              content_url: 'https://custom.cdn.com/content/test-id',
              content_type: 'video/mp4'
            })
          };
        }
        expect(url).toBe('https://custom.cdn.com/content/test-id');
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([9, 10]).buffer
        };
      });

      const result = await provider.getInscriptionById('test-id');
      expect(result).not.toBeNull();
    });

    test('handles Buffer environment when Buffer is unavailable', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      (globalThis as any).Buffer = undefined;
      
      let callCount = 0;
      fetchSpy = spyOn(globalThis as any, 'fetch').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              inscription_id: 'test-id',
              content_type: 'text/plain'
            })
          };
        }
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([11, 12]).buffer
        };
      });

      const result = await provider.getInscriptionById('test-id');
      expect(result).not.toBeNull();
      expect(result?.content).toBeInstanceOf(Uint8Array);
    });
  });

  describe('getInscriptionsBySatoshi', () => {
    test('returns empty array for empty satoshi', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.getInscriptionsBySatoshi('');
      expect(result).toEqual([]);
    });

    test('returns empty array when fetch fails', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      fetchSpy = spyOn(globalThis as any, 'fetch').mockResolvedValue({
        ok: false,
        status: 404
      });

      const result = await provider.getInscriptionsBySatoshi('12345');
      expect(result).toEqual([]);
    });

    test('returns inscription ids when found', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      fetchSpy = spyOn(globalThis as any, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          inscription_ids: ['id1', 'id2', 'id3']
        })
      });

      const result = await provider.getInscriptionsBySatoshi('12345');
      expect(result).toEqual([
        { inscriptionId: 'id1' },
        { inscriptionId: 'id2' },
        { inscriptionId: 'id3' }
      ]);
    });

    test('returns empty array when inscription_ids is missing', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      fetchSpy = spyOn(globalThis as any, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      const result = await provider.getInscriptionsBySatoshi('12345');
      expect(result).toEqual([]);
    });

    test('returns empty array when inscription_ids is not an array', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      fetchSpy = spyOn(globalThis as any, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          inscription_ids: 'not-an-array'
        })
      });

      const result = await provider.getInscriptionsBySatoshi('12345');
      expect(result).toEqual([]);
    });
  });

  describe('broadcastTransaction', () => {
    test('returns placeholder txid', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.broadcastTransaction('0102030405');
      expect(result).toBe('broadcast-txid');
    });
  });

  describe('getTransactionStatus', () => {
    test('returns unconfirmed status', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.getTransactionStatus('any-txid');
      expect(result).toEqual({ confirmed: false });
    });
  });

  describe('estimateFee', () => {
    test('returns fee for default blocks (1)', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.estimateFee();
      expect(result).toBe(5);
    });

    test('returns fee for 6 blocks', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.estimateFee(6);
      expect(result).toBe(30);
    });

    test('returns fee for 0 blocks (clamped to 1)', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.estimateFee(0);
      expect(result).toBe(5);
    });
  });

  describe('createInscription', () => {
    test('creates inscription with random ids', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const data = Buffer.from('test data');
      const result = await provider.createInscription({
        data,
        contentType: 'text/plain',
        feeRate: 10
      });

      expect(result.inscriptionId).toMatch(/^insc-/);
      expect(result.txid).toMatch(/^tx-/);
      expect(result.revealTxId).toBe(result.txid);
      expect(result.vout).toBe(0);
      expect(result.blockHeight).toBeUndefined();
      expect(result.content).toBe(data);
      expect(result.contentType).toBe('text/plain');
      expect(result.feeRate).toBe(10);
    });

    test('creates inscription without feeRate', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.createInscription({
        data: Buffer.from('data'),
        contentType: 'image/png'
      });

      expect(result.feeRate).toBeUndefined();
      expect(result.contentType).toBe('image/png');
    });
  });

  describe('transferInscription', () => {
    test('throws error for empty inscriptionId', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      await expect(provider.transferInscription('', 'address123')).rejects.toThrow('inscriptionId required');
    });

    test('returns transfer result with random txid', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.transferInscription('insc123', 'bc1qaddress');

      expect(result.txid).toMatch(/^tx-/);
      expect(result.vin).toEqual([{ txid: 'prev', vout: 0 }]);
      expect(result.vout).toEqual([{ value: 546, scriptPubKey: 'script' }]);
      expect(result.fee).toBe(100);
      expect(result.confirmations).toBe(0);
    });

    test('accepts feeRate option', async () => {
      const provider = new OrdHttpProvider({ baseUrl: 'https://api.example.com' });
      const result = await provider.transferInscription('insc123', 'bc1qaddress', { feeRate: 20 });
      expect(result).toBeDefined();
    });
  });
});

describe('createOrdinalsProviderFromEnv', () => {
  let originalProcess: any;

  beforeEach(() => {
    originalProcess = (globalThis as any).process;
  });

  afterEach(() => {
    if (originalProcess !== undefined) {
      (globalThis as any).process = originalProcess;
    } else {
      delete (globalThis as any).process;
    }
  });

  test('returns OrdMockProvider when USE_LIVE_ORD_PROVIDER is not true', async () => {
    (globalThis as any).process = {
      env: {
        USE_LIVE_ORD_PROVIDER: 'false'
      }
    };

    const provider = await createOrdinalsProviderFromEnv();
    expect(provider.constructor.name).toBe('OrdMockProvider');
  });

  test('returns OrdMockProvider when USE_LIVE_ORD_PROVIDER is missing', async () => {
    (globalThis as any).process = {
      env: {}
    };

    const provider = await createOrdinalsProviderFromEnv();
    expect(provider.constructor.name).toBe('OrdMockProvider');
  });

  test('returns OrdHttpProvider when USE_LIVE_ORD_PROVIDER is true', async () => {
    (globalThis as any).process = {
      env: {
        USE_LIVE_ORD_PROVIDER: 'true',
        ORD_PROVIDER_BASE_URL: 'https://custom.api.com'
      }
    };

    const provider = await createOrdinalsProviderFromEnv();
    expect(provider.constructor.name).toBe('OrdHttpProvider');
  });

  test('returns OrdHttpProvider with default URL when ORD_PROVIDER_BASE_URL is missing', async () => {
    (globalThis as any).process = {
      env: {
        USE_LIVE_ORD_PROVIDER: 'TRUE'
      }
    };

    const provider = await createOrdinalsProviderFromEnv();
    expect(provider.constructor.name).toBe('OrdHttpProvider');
  });

  test('handles missing process.env gracefully', async () => {
    (globalThis as any).process = undefined;

    const provider = await createOrdinalsProviderFromEnv();
    expect(provider.constructor.name).toBe('OrdMockProvider');
  });
});
