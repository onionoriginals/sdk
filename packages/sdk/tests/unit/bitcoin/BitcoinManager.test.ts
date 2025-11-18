import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import type { OrdinalsProvider } from '../../../src/adapters';
import { DUST_LIMIT_SATS } from '../../../src/types';
// Use global Buffer available in Node test environment

const createMockProvider = () => {
  const inscriptions: Record<string, { satoshi?: string }> = {};
  let counter = 0;
  const provider: OrdinalsProvider = {
    async createInscription({ data, contentType, feeRate }) {
      const inscriptionId = counter === 0 ? 'insc-test' : `insc-test-${counter}`;
      counter += 1;
      inscriptions[inscriptionId] = { satoshi: '123456789' };
      return {
        inscriptionId,
        revealTxId: 'tx-reveal-1',
        commitTxId: 'tx-commit-1',
        satoshi: '123456789',
        txid: 'tx-output-1',
        vout: 1,
        blockHeight: 100,
        content: data,
        contentType,
        feeRate
      };
    },
    async getInscriptionById(id: string) {
      const info = inscriptions[id];
      if (!info) return null;
      return {
        inscriptionId: id,
        content: Buffer.from('payload'),
        contentType: 'application/json',
        txid: 'tx-output-1',
        vout: 1,
        satoshi: info.satoshi,
        blockHeight: 100
      };
    },
    async transferInscription(inscriptionId, toAddress, options) {
      if (!inscriptions[inscriptionId]) {
        throw new Error('unknown inscription');
      }
      return {
        txid: 'tx-transfer-1',
        vin: [{ txid: 'tx-output-1', vout: 1 }],
        vout: [{ value: 12_000, scriptPubKey: 'script', address: toAddress }],
        fee: options?.feeRate ? Math.round(options.feeRate) : 100,
        satoshi: inscriptions[inscriptionId].satoshi,
        confirmations: 0
      };
    },
    async getInscriptionsBySatoshi(satoshi: string) {
      return Object.entries(inscriptions)
        .filter(([, info]) => info.satoshi === satoshi)
        .map(([id]) => ({ inscriptionId: id }));
    },
    async broadcastTransaction() {
      return 'tx-broadcast';
    },
    async getTransactionStatus() {
      return { confirmed: false };
    },
    async estimateFee(blocks = 1) {
      return 5 * blocks;
    }
  } as OrdinalsProvider;

  return provider;
};

describe('BitcoinManager integration with providers', () => {
  test('inscribeData surfaces provider metadata', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: provider,
      feeOracle: { estimateFeeRate: async () => 7 }
    } as any);

    const result = await sdk.bitcoin.inscribeData(Buffer.from('hello'), 'text/plain');
    expect(result.inscriptionId).toBe('insc-test');
    expect(result.satoshi).toBe('123456789');
    expect((result as any).revealTxId).toBe('tx-reveal-1');
    expect((result as any).feeRate).toBe(7);
  });

  test('inscribeData resolves satoshi via fallback when provider omits it', async () => {
    const inscriptions: Record<string, { satoshi?: string }> = {};
    const provider: OrdinalsProvider = {
      async createInscription({ data, contentType }) {
        const inscriptionId = 'insc-no-sat';
        inscriptions[inscriptionId] = { satoshi: '999888777' };
        return {
          inscriptionId,
          revealTxId: 'tx-reveal-2',
          txid: 'tx-output-2',
          vout: 0,
          content: data,
          contentType
        } as any;
      },
      async getInscriptionById(id: string) {
        const satoshi = inscriptions[id]?.satoshi;
        return satoshi
          ? {
              inscriptionId: id,
              content: Buffer.from('x'),
              contentType: 'text/plain',
              txid: 'tx-output-2',
              vout: 0,
              satoshi
            }
          : null;
      },
      async transferInscription() {
        throw new Error('noop');
      },
      async getInscriptionsBySatoshi() {
        return [];
      },
      async broadcastTransaction() {
        return 'tx';
      },
      async getTransactionStatus() {
        return { confirmed: false };
      },
      async estimateFee() {
        return 3;
      }
    } as OrdinalsProvider;

    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const result = await sdk.bitcoin.inscribeData(Buffer.from('x'), 'text/plain');
    expect(result.satoshi).toBe('999888777');
  });

  test('inscribeData propagates provider errors', async () => {
    const provider: OrdinalsProvider = {
      async createInscription() {
        throw new Error('boom');
      },
      async getInscriptionById() {
        return null;
      },
      async transferInscription() {
        throw new Error('noop');
      },
      async getInscriptionsBySatoshi() {
        return [];
      },
      async broadcastTransaction() {
        return 'tx';
      },
      async getTransactionStatus() {
        return { confirmed: false };
      },
      async estimateFee() {
        return 1;
      }
    };

    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    await expect(
      sdk.bitcoin.inscribeData(Buffer.from('data'), 'text/plain')
    ).rejects.toThrow('boom');
  });

  test('trackInscription defers to provider data', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const created = await sdk.bitcoin.inscribeData(Buffer.from('payload'), 'text/plain');
    const tracked = await sdk.bitcoin.trackInscription(created.inscriptionId);
    expect(tracked?.txid).toBe('tx-output-1');
    expect(tracked?.blockHeight).toBe(100);
  });

  test('transferInscription returns provider transaction shape', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const inscription = await sdk.bitcoin.inscribeData(Buffer.from('payload'), 'text/plain');
    const tx = await sdk.bitcoin.transferInscription(inscription, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    expect(tx.txid).toBe('tx-transfer-1');
    expect(tx.vout[0].address).toBe('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  });

  test('transferInscription enforces dust limit on fallback vout', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    const inscription = await sdk.bitcoin.inscribeData(Buffer.from('payload'), 'text/plain');
    // provider returns vout with value 12_000 so skip; force empty vout by using a provider that returns none
    const provider2: OrdinalsProvider = {
      ...provider,
      async transferInscription() {
        return { txid: 'tx', vin: [{ txid: 'a', vout: 0 }], vout: [], fee: 1 } as any;
      }
    } as OrdinalsProvider;
    const sdk2 = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider2 } as any);
    const tx2 = await sdk2.bitcoin.transferInscription(inscription, 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
    expect(tx2.vout[0].value).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
    expect(tx2.vout[0].address).toBe('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
  });

  test('getSatoshiFromInscription returns null when provider missing', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    expect(await sdk.bitcoin.getSatoshiFromInscription('unknown')).toBeNull();
  });

  test('validateBTCODID checks provider assignments', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    await sdk.bitcoin.inscribeData(Buffer.from('payload'), 'text/plain');
    await expect(sdk.bitcoin.validateBTCODID('did:btco:123456789')).resolves.toBe(true);
    await expect(sdk.bitcoin.validateBTCODID('did:btco:999999999')).resolves.toBe(false);
  });

  test('validateBTCODID rejects invalid network prefixes', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    await sdk.bitcoin.inscribeData(Buffer.from('payload'), 'text/plain');
    
    // Valid networks should work
    await expect(sdk.bitcoin.validateBTCODID('did:btco:test:123456789')).resolves.toBe(true);
    await expect(sdk.bitcoin.validateBTCODID('did:btco:sig:123456789')).resolves.toBe(true);
    
    // Invalid network prefix should be rejected
    await expect(sdk.bitcoin.validateBTCODID('did:btco:invalid:123456789')).resolves.toBe(false);
    await expect(sdk.bitcoin.validateBTCODID('did:btco:mainnet:123456789')).resolves.toBe(false);
    await expect(sdk.bitcoin.validateBTCODID('did:btco:regtest:123456789')).resolves.toBe(false);
  });

  test('preventFrontRunning returns false when multiple inscriptions exist on same satoshi', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    await sdk.bitcoin.inscribeData(Buffer.from('payload1'), 'text/plain');
    await sdk.bitcoin.inscribeData(Buffer.from('payload2'), 'text/plain');
    const canProceed = await sdk.bitcoin.preventFrontRunning('123456789');
    expect(canProceed).toBe(false);
  });

  test('resolveFeeRate prefers feeOracle over provider and provided value', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: provider,
      feeOracle: { estimateFeeRate: async () => 9 }
    } as any);
    const res: any = await sdk.bitcoin.inscribeData(Buffer.from('hello'), 'text/plain', 2);
    expect(res.feeRate).toBe(9);
  });

  test('inscribeData throws ORD_PROVIDER_REQUIRED when provider not configured', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    try {
      await sdk.bitcoin.inscribeData(Buffer.from('data'), 'text/plain');
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.code).toBe('ORD_PROVIDER_REQUIRED');
      expect(error.message).toContain('Ordinals provider must be configured');
    }
  });

  test('transferInscription throws ORD_PROVIDER_REQUIRED when provider not configured', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const mockInscription = {
      inscriptionId: 'test-id',
      satoshi: 'sat-123',
      content: Buffer.from('test'),
      contentType: 'text/plain',
      txid: 'tx-123',
      vout: 0
    };
    try {
      await sdk.bitcoin.transferInscription(mockInscription, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.code).toBe('ORD_PROVIDER_REQUIRED');
      expect(error.message).toContain('Ordinals provider must be configured');
    }
  });

  test('validateBitcoinConfig throws when ordinalsProvider not configured', () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    expect(() => sdk.validateBitcoinConfig()).toThrow('Bitcoin operations require an ordinalsProvider');
  });

  test('validateBitcoinConfig passes when ordinalsProvider is configured', () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    expect(() => sdk.validateBitcoinConfig()).not.toThrow();
  });
});

describe('BitcoinManager DID-specific methods', () => {
  test('inscribeDID serializes and inscribes DID document', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

    const didDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw',
      verificationMethod: [
        {
          id: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw#z6MkY',
          type: 'Multikey',
          controller: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw',
          publicKeyMultibase: 'z6MkY'
        }
      ],
      authentication: ['did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw#z6MkY']
    };

    const result = await sdk.bitcoin.inscribeDID(didDocument);
    expect(result.inscriptionId).toBe('insc-test');
    expect(result.satoshi).toBe('123456789');
    expect(result.contentType).toBe('application/json');
  });

  test('inscribeDID throws for invalid DID document', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

    // Missing id
    try {
      await sdk.bitcoin.inscribeDID({} as any);
      throw new Error('Expected error');
    } catch (error: any) {
      expect(error.code).toBe('INVALID_INPUT');
    }

    // Missing verificationMethod
    try {
      await sdk.bitcoin.inscribeDID({ id: 'did:test', '@context': [] } as any);
      throw new Error('Expected error');
    } catch (error: any) {
      expect(error.code).toBe('INVALID_INPUT');
    }

    // Empty verificationMethod
    try {
      await sdk.bitcoin.inscribeDID({
        id: 'did:test',
        '@context': [],
        verificationMethod: []
      } as any);
      throw new Error('Expected error');
    } catch (error: any) {
      expect(error.code).toBe('INVALID_INPUT');
    }
  });

  test('inscribeDID respects custom fee rate', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

    const didDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw',
      verificationMethod: [
        {
          id: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw#z6MkY',
          type: 'Multikey',
          controller: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw',
          publicKeyMultibase: 'z6MkY'
        }
      ],
      authentication: ['did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw#z6MkY']
    };

    const result = await sdk.bitcoin.inscribeDID(didDocument, 10);
    expect((result as any).feeRate).toBe(10);
  });

  test('inscribeDID throws when provider not configured', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });

    const didDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw',
      verificationMethod: [
        {
          id: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw#z6MkY',
          type: 'Multikey',
          controller: 'did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw',
          publicKeyMultibase: 'z6MkY'
        }
      ],
      authentication: ['did:peer:z1A1Eh8cKS7jCpjoknp3CAc5JzXw#z6MkY']
    };

    try {
      await sdk.bitcoin.inscribeDID(didDocument);
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.code).toBe('ORD_PROVIDER_REQUIRED');
    }
  });

  test('transferDID transfers inscription by did:btco identifier', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

    // First inscribe to set up satoshi
    await sdk.bitcoin.inscribeData(Buffer.from('test'), 'text/plain');

    // Transfer using did:btco format
    const tx = await sdk.bitcoin.transferDID('did:btco:123456789', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    expect(tx.txid).toBe('tx-transfer-1');
    expect(tx.vout[0].address).toBe('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
  });

  test('transferDID transfers inscription by raw satoshi identifier', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

    // First inscribe to set up satoshi
    await sdk.bitcoin.inscribeData(Buffer.from('test'), 'text/plain');

    // Transfer using raw satoshi
    const tx = await sdk.bitcoin.transferDID('123456789', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    expect(tx.txid).toBe('tx-transfer-1');
  });

  test('transferDID extracts satoshi from network-prefixed did:btco DIDs', async () => {
    const inscriptions: Record<string, { satoshi?: string }> = { 'test-insc': { satoshi: '999888777' } };
    const provider: OrdinalsProvider = {
      ...createMockProvider(),
      async getInscriptionsBySatoshi(satoshi: string) {
        if (satoshi === '999888777') {
          return [
            {
              inscriptionId: 'test-insc',
              contentType: 'application/json',
              content: Buffer.from('{}'),
              txid: 'tx-123',
              vout: 0
            }
          ];
        }
        return [];
      },
      async transferInscription() {
        return {
          txid: 'tx-transfer',
          vin: [{ txid: 'tx-123', vout: 0 }],
          vout: [{ value: 12000, scriptPubKey: 'script', address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }],
          fee: 100
        };
      }
    } as OrdinalsProvider;

    const sdk = OriginalsSDK.create({ network: 'testnet', ordinalsProvider: provider } as any);

    // Transfer using network-prefixed did:btco (testnet)
    const tx = await sdk.bitcoin.transferDID('did:btco:test:999888777', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    expect(tx.txid).toBe('tx-transfer');
  });

  test('transferDID throws for invalid address', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

    try {
      await sdk.bitcoin.transferDID('did:btco:123456789', 'invalid-address');
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.code).toBe('INVALID_ADDRESS');
    }
  });

  test('transferDID throws for invalid satoshi', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

    try {
      await sdk.bitcoin.transferDID('invalid-satoshi', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.code).toBe('INVALID_SATOSHI');
    }
  });

  test('transferDID throws when inscription not found', async () => {
    const provider: OrdinalsProvider = {
      ...createMockProvider(),
      async getInscriptionsBySatoshi() {
        return [];
      }
    } as OrdinalsProvider;

    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);

    try {
      await sdk.bitcoin.transferDID('did:btco:999999999', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.code).toBe('INSCRIPTION_NOT_FOUND');
    }
  });

  test('transferDID throws when provider not configured', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });

    try {
      await sdk.bitcoin.transferDID('did:btco:123456789', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
      throw new Error('Expected error to be thrown');
    } catch (error: any) {
      expect(error.code).toBe('ORD_PROVIDER_REQUIRED');
    }
  });
});
