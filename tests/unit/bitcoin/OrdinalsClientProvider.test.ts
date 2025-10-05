import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { OrdinalsClientProvider } from '../../../src/bitcoin/providers/OrdinalsProvider';
import { OrdinalsClient } from '../../../src/bitcoin/OrdinalsClient';
import { withRetry } from '../../../src/utils/retry';

describe('OrdinalsClientProvider', () => {
  let mockClient: OrdinalsClient;

  beforeEach(() => {
    // Create a mock OrdinalsClient
    mockClient = {
      getSatInfo: async () => ({ inscription_ids: [] }),
      getInscriptionById: async () => null,
      getMetadata: async () => ({}),
      estimateFee: async () => 1
    } as any;
  });

  describe('constructor', () => {
    test('creates provider with client only', () => {
      const provider = new OrdinalsClientProvider(mockClient);
      expect(provider).toBeDefined();
    });

    test('creates provider with client and options', () => {
      const provider = new OrdinalsClientProvider(mockClient, {
        retries: 5,
        baseUrl: 'https://api.example.com'
      });
      expect(provider).toBeDefined();
    });

    test('creates provider with empty options', () => {
      const provider = new OrdinalsClientProvider(mockClient, {});
      expect(provider).toBeDefined();
    });
  });

  describe('getSatInfo', () => {
    test('calls client.getSatInfo with satNumber', async () => {
      const getSatInfoSpy = spyOn(mockClient, 'getSatInfo').mockResolvedValue({
        inscription_ids: ['id1', 'id2']
      });

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.getSatInfo('12345');

      expect(getSatInfoSpy).toHaveBeenCalledWith('12345');
      expect(result.inscription_ids).toEqual(['id1', 'id2']);

      getSatInfoSpy.mockRestore();
    });

    test('uses default retry count of 2', async () => {
      let attemptCount = 0;
      const getSatInfoSpy = spyOn(mockClient, 'getSatInfo').mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error('Temporary failure');
        }
        return { inscription_ids: ['id1'] };
      });

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.getSatInfo('12345');

      expect(attemptCount).toBe(2);
      expect(result.inscription_ids).toEqual(['id1']);

      getSatInfoSpy.mockRestore();
    });

    test('uses custom retry count', async () => {
      let attemptCount = 0;
      const getSatInfoSpy = spyOn(mockClient, 'getSatInfo').mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 4) {
          throw new Error('Temporary failure');
        }
        return { inscription_ids: ['id1'] };
      });

      const provider = new OrdinalsClientProvider(mockClient, { retries: 5 });
      const result = await provider.getSatInfo('12345');

      expect(attemptCount).toBe(4);
      expect(result.inscription_ids).toEqual(['id1']);

      getSatInfoSpy.mockRestore();
    });

    test('returns empty inscription_ids array', async () => {
      const getSatInfoSpy = spyOn(mockClient, 'getSatInfo').mockResolvedValue({
        inscription_ids: []
      });

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.getSatInfo('99999');

      expect(result.inscription_ids).toEqual([]);

      getSatInfoSpy.mockRestore();
    });
  });

  describe('resolveInscription', () => {
    test('throws error when inscription not found', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue(null);

      const provider = new OrdinalsClientProvider(mockClient, { baseUrl: 'https://api.example.com' });

      await expect(provider.resolveInscription('missing-id')).rejects.toThrow('Inscription not found');

      getInscriptionSpy.mockRestore();
    });

    test('throws error when satoshi is missing', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue({
        inscriptionId: 'test-id',
        content: Buffer.from('data'),
        contentType: 'text/plain',
        txid: 'abc',
        vout: 0
      });

      const provider = new OrdinalsClientProvider(mockClient, { baseUrl: 'https://api.example.com' });

      await expect(provider.resolveInscription('test-id')).rejects.toThrow('Inscription missing satoshi');

      getInscriptionSpy.mockRestore();
    });

    test('throws error when satoshi is invalid (NaN)', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue({
        inscriptionId: 'test-id',
        content: Buffer.from('data'),
        contentType: 'text/plain',
        txid: 'abc',
        vout: 0,
        satoshi: 'not-a-number'
      });

      const provider = new OrdinalsClientProvider(mockClient, { baseUrl: 'https://api.example.com' });

      await expect(provider.resolveInscription('test-id')).rejects.toThrow('Invalid satoshi value');

      getInscriptionSpy.mockRestore();
    });

    test('throws error when contentType is missing', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue({
        inscriptionId: 'test-id',
        content: Buffer.from('data'),
        contentType: '',
        txid: 'abc',
        vout: 0,
        satoshi: '12345'
      });

      const provider = new OrdinalsClientProvider(mockClient, { baseUrl: 'https://api.example.com' });

      await expect(provider.resolveInscription('test-id')).rejects.toThrow('Inscription missing contentType');

      getInscriptionSpy.mockRestore();
    });

    test('throws error when baseUrl is missing', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue({
        inscriptionId: 'test-id',
        content: Buffer.from('data'),
        contentType: 'text/plain',
        txid: 'abc',
        vout: 0,
        satoshi: '12345'
      });

      const provider = new OrdinalsClientProvider(mockClient); // No baseUrl

      await expect(provider.resolveInscription('test-id')).rejects.toThrow('baseUrl is required to construct content_url');

      getInscriptionSpy.mockRestore();
    });

    test('throws error when baseUrl is empty string', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue({
        inscriptionId: 'test-id',
        content: Buffer.from('data'),
        contentType: 'text/plain',
        txid: 'abc',
        vout: 0,
        satoshi: '12345'
      });

      const provider = new OrdinalsClientProvider(mockClient, { baseUrl: '' });

      await expect(provider.resolveInscription('test-id')).rejects.toThrow('baseUrl is required to construct content_url');

      getInscriptionSpy.mockRestore();
    });

    test('successfully resolves inscription', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue({
        inscriptionId: 'insc123',
        content: Buffer.from('test data'),
        contentType: 'image/png',
        txid: 'tx456',
        vout: 1,
        satoshi: '987654'
      });

      const provider = new OrdinalsClientProvider(mockClient, { baseUrl: 'https://api.example.com' });
      const result = await provider.resolveInscription('insc123');

      expect(result.id).toBe('insc123');
      expect(result.sat).toBe(987654);
      expect(result.content_type).toBe('image/png');
      expect(result.content_url).toBe('https://api.example.com/content/insc123');

      getInscriptionSpy.mockRestore();
    });

    test('trims trailing slash from baseUrl', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue({
        inscriptionId: 'insc789',
        content: Buffer.from('data'),
        contentType: 'text/html',
        txid: 'tx',
        vout: 0,
        satoshi: '111111'
      });

      const provider = new OrdinalsClientProvider(mockClient, { baseUrl: 'https://api.example.com///' });
      const result = await provider.resolveInscription('insc789');

      expect(result.content_url).toBe('https://api.example.com/content/insc789');
      expect(result.content_url).not.toContain('///');

      getInscriptionSpy.mockRestore();
    });

    test('retries on failure', async () => {
      let attemptCount = 0;
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error('Temporary network error');
        }
        return {
          inscriptionId: 'insc-retry',
          content: Buffer.from('data'),
          contentType: 'text/plain',
          txid: 'tx',
          vout: 0,
          satoshi: '12345'
        };
      });

      const provider = new OrdinalsClientProvider(mockClient, { 
        baseUrl: 'https://api.example.com',
        retries: 3
      });
      const result = await provider.resolveInscription('insc-retry');

      expect(attemptCount).toBe(2);
      expect(result.id).toBe('insc-retry');

      getInscriptionSpy.mockRestore();
    });

    test('handles numeric satoshi value', async () => {
      const getInscriptionSpy = spyOn(mockClient, 'getInscriptionById').mockResolvedValue({
        inscriptionId: 'insc-num',
        content: Buffer.from('data'),
        contentType: 'text/plain',
        txid: 'tx',
        vout: 0,
        satoshi: 555555 as any // Number instead of string
      });

      const provider = new OrdinalsClientProvider(mockClient, { baseUrl: 'https://api.example.com' });
      const result = await provider.resolveInscription('insc-num');

      expect(result.sat).toBe(555555);

      getInscriptionSpy.mockRestore();
    });
  });

  describe('getMetadata', () => {
    test('calls client.getMetadata with inscriptionId', async () => {
      const metadata = { foo: 'bar', baz: 123 };
      const getMetadataSpy = spyOn(mockClient, 'getMetadata').mockResolvedValue(metadata);

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.getMetadata('test-id');

      expect(getMetadataSpy).toHaveBeenCalledWith('test-id');
      expect(result).toEqual(metadata);

      getMetadataSpy.mockRestore();
    });

    test('uses default retry count of 2', async () => {
      let attemptCount = 0;
      const getMetadataSpy = spyOn(mockClient, 'getMetadata').mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error('Temporary failure');
        }
        return { data: 'success' };
      });

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.getMetadata('test-id');

      expect(attemptCount).toBe(2);
      expect(result.data).toBe('success');

      getMetadataSpy.mockRestore();
    });

    test('uses custom retry count', async () => {
      let attemptCount = 0;
      const getMetadataSpy = spyOn(mockClient, 'getMetadata').mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Temporary failure');
        }
        return { data: 'success' };
      });

      const provider = new OrdinalsClientProvider(mockClient, { retries: 4 });
      await provider.getMetadata('test-id');

      expect(attemptCount).toBe(3);

      getMetadataSpy.mockRestore();
    });

    test('returns empty object', async () => {
      const getMetadataSpy = spyOn(mockClient, 'getMetadata').mockResolvedValue({});

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.getMetadata('test-id');

      expect(result).toEqual({});

      getMetadataSpy.mockRestore();
    });
  });

  describe('estimateFee', () => {
    test('calls client.estimateFee without blocks parameter', async () => {
      const estimateFeeSpy = spyOn(mockClient, 'estimateFee').mockResolvedValue(5);

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.estimateFee();

      expect(estimateFeeSpy).toHaveBeenCalledWith(undefined);
      expect(result).toBe(5);

      estimateFeeSpy.mockRestore();
    });

    test('calls client.estimateFee with blocks parameter', async () => {
      const estimateFeeSpy = spyOn(mockClient, 'estimateFee').mockResolvedValue(10);

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.estimateFee(6);

      expect(estimateFeeSpy).toHaveBeenCalledWith(6);
      expect(result).toBe(10);

      estimateFeeSpy.mockRestore();
    });

    test('uses default retry count of 2', async () => {
      let attemptCount = 0;
      const estimateFeeSpy = spyOn(mockClient, 'estimateFee').mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error('Temporary failure');
        }
        return 15;
      });

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.estimateFee(3);

      expect(attemptCount).toBe(2);
      expect(result).toBe(15);

      estimateFeeSpy.mockRestore();
    });

    test('uses custom retry count', async () => {
      let attemptCount = 0;
      const estimateFeeSpy = spyOn(mockClient, 'estimateFee').mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 5) {
          throw new Error('Temporary failure');
        }
        return 20;
      });

      const provider = new OrdinalsClientProvider(mockClient, { retries: 6 });
      const result = await provider.estimateFee();

      expect(attemptCount).toBe(5);
      expect(result).toBe(20);

      estimateFeeSpy.mockRestore();
    });

    test('returns zero fee', async () => {
      const estimateFeeSpy = spyOn(mockClient, 'estimateFee').mockResolvedValue(0);

      const provider = new OrdinalsClientProvider(mockClient);
      const result = await provider.estimateFee();

      expect(result).toBe(0);

      estimateFeeSpy.mockRestore();
    });
  });

  describe('retry behavior across methods', () => {
    test('all methods use isRetriable that always returns true', async () => {
      // Test that errors are retried regardless of type
      let attemptCount = 0;
      const getSatInfoSpy = spyOn(mockClient, 'getSatInfo').mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error('Any error type');
        }
        return { inscription_ids: [] };
      });

      const provider = new OrdinalsClientProvider(mockClient, { retries: 3 });
      await provider.getSatInfo('12345');

      expect(attemptCount).toBe(2);

      getSatInfoSpy.mockRestore();
    });
  });
});
