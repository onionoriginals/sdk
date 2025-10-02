import { describe, test, expect } from 'bun:test';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('OrdMockProvider', () => {
  test('createInscription and retrieval works', async () => {
    const prov = new OrdMockProvider();
    const data = Buffer.from('hello');
    const res = await prov.createInscription({ data, contentType: 'text/plain' });
    expect(typeof res.inscriptionId).toBe('string');
    const fetched = await prov.getInscriptionById(res.inscriptionId);
    expect(fetched?.txid).toBe(res.txid);
  });

  test('broadcastTransaction returns mock txid', async () => {
    const prov = new OrdMockProvider();
    const txid = await prov.broadcastTransaction('mock-tx-hex');
    expect(txid).toBe('mock-broadcast-txid');
  });

  test('getTransactionStatus returns confirmed status', async () => {
    const prov = new OrdMockProvider();
    const status = await prov.getTransactionStatus('any-txid');
    expect(status.confirmed).toBe(true);
    expect(status.blockHeight).toBe(1);
    expect(status.confirmations).toBe(1);
  });

  test('estimateFee with default blocks', async () => {
    const prov = new OrdMockProvider();
    const fee = await prov.estimateFee();
    expect(fee).toBeGreaterThanOrEqual(1);
  });

  test('estimateFee with multiple blocks reduces fee', async () => {
    const prov = new OrdMockProvider({ feeRate: 10 });
    const fee1 = await prov.estimateFee(1);
    const fee3 = await prov.estimateFee(3);
    expect(fee1).toBe(10);
    expect(fee3).toBe(8); // 10 - (3-1) = 8
  });

  test('transferInscription throws error for non-existent inscription', async () => {
    const prov = new OrdMockProvider();
    await expect(prov.transferInscription('non-existent', 'bc1qaddress'))
      .rejects.toThrow('inscription not found');
  });

  test('constructor accepts custom state', async () => {
    const customState = new Map();
    customState.set('test-id', {
      inscriptionId: 'test-id',
      content: Buffer.from('test'),
      contentType: 'text/plain',
      txid: 'test-txid',
      vout: 0,
      satoshi: 'test-sat'
    });

    const prov = new OrdMockProvider({
      inscriptionsById: customState,
      feeRate: 10
    });

    const inscription = await prov.getInscriptionById('test-id');
    expect(inscription).toBeDefined();
    expect(inscription?.inscriptionId).toBe('test-id');
  });
});

