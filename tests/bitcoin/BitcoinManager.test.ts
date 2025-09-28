import { OriginalsSDK } from '../../src';
import { expect } from '@jest/globals';
import type { OrdinalsProvider } from '../../src/adapters';

const createMockProvider = () => {
  const inscriptions: Record<string, { satoshi?: string }> = {};
  const provider: OrdinalsProvider = {
    async createInscription({ data, contentType, feeRate }) {
      const inscriptionId = 'insc-test';
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
    await sdk.bitcoin.inscribeData(Buffer.from('payload'), 'text/plain');
    const tracked = await sdk.bitcoin.trackInscription('insc-test');
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
});
