import { OriginalsSDK } from '../../src';
import type { OrdinalsProvider } from '../../src/adapters';
import { DUST_LIMIT_SATS } from '../../src/types';
// Use global Buffer available in Node test environment

const createMockProvider = () => {
  const inscriptions: Record<string, { satoshi?: string }> = {};
  let counter = 0;
  const provider: OrdinalsProvider = {
    async createInscription({ data, contentType, feeRate }) {
      const inscriptionId = counter === 0 ? 'insc-test' : `insc-test-${counter}`;
      counter += 1;
      inscriptions[inscriptionId] = { satoshi: 'sat-123' };
      return {
        inscriptionId,
        revealTxId: 'tx-reveal-1',
        commitTxId: 'tx-commit-1',
        satoshi: 'sat-123',
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
    expect(result.satoshi).toBe('sat-123');
    expect((result as any).revealTxId).toBe('tx-reveal-1');
    expect((result as any).feeRate).toBe(7);
  });

  test('inscribeData resolves satoshi via fallback when provider omits it', async () => {
    const inscriptions: Record<string, { satoshi?: string }> = {};
    const provider: OrdinalsProvider = {
      async createInscription({ data, contentType }) {
        const inscriptionId = 'insc-no-sat';
        inscriptions[inscriptionId] = { satoshi: 'sat-999' };
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
    expect(result.satoshi).toBe('sat-999');
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
    const tx = await sdk.bitcoin.transferInscription(inscription, 'bcrt1qexample');
    expect(tx.txid).toBe('tx-transfer-1');
    expect(tx.vout[0].address).toBe('bcrt1qexample');
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
    const tx2 = await sdk2.bitcoin.transferInscription(inscription, 'bcrt1qdust');
    expect(tx2.vout[0].value).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
    expect(tx2.vout[0].address).toBe('bcrt1qdust');
  });

  test('getSatoshiFromInscription returns null when provider missing', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    expect(await sdk.bitcoin.getSatoshiFromInscription('unknown')).toBeNull();
  });

  test('validateBTCODID checks provider assignments', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    await sdk.bitcoin.inscribeData(Buffer.from('payload'), 'text/plain');
    await expect(sdk.bitcoin.validateBTCODID('did:btco:sat-123')).resolves.toBe(true);
    await expect(sdk.bitcoin.validateBTCODID('did:btco:missing')).resolves.toBe(false);
  });

  test('preventFrontRunning returns false when multiple inscriptions exist on same satoshi', async () => {
    const provider = createMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider } as any);
    await sdk.bitcoin.inscribeData(Buffer.from('payload1'), 'text/plain');
    await sdk.bitcoin.inscribeData(Buffer.from('payload2'), 'text/plain');
    const canProceed = await sdk.bitcoin.preventFrontRunning('sat-123');
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
});
