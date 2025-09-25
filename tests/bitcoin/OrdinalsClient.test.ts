import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';

const client = new OrdinalsClient('http://localhost:3000', 'regtest');

describe('OrdinalsClient', () => {
  test('getInscriptionById returns inscription (expected to fail until implemented)', async () => {
    await expect(client.getInscriptionById('abc')).resolves.not.toBeNull();
  });

  test('getInscriptionsBySatoshi returns array (expected to fail until implemented)', async () => {
    await expect(client.getInscriptionsBySatoshi('123')).resolves.toEqual(expect.any(Array));
  });

  test('broadcastTransaction returns txid (expected to fail until implemented)', async () => {
    await expect(client.broadcastTransaction({ txid: 't', vin: [], vout: [], fee: 0 })).resolves.toEqual(expect.any(String));
  });

  test('broadcastTransaction falls back when txid missing', async () => {
    // @ts-ignore
    await expect(client.broadcastTransaction({ vin: [], vout: [], fee: 0 })).resolves.toEqual('txid');
  });

  test('getTransactionStatus returns status (expected to fail until implemented)', async () => {
    const status = await client.getTransactionStatus('txid');
    expect(status.confirmed).toBeDefined();
  });

  test('estimateFee returns a number (expected to fail until implemented)', async () => {
    await expect(client.estimateFee(1)).resolves.toEqual(expect.any(Number));
  });

  test('estimateFee default parameter path (expected to fail until implemented)', async () => {
    await expect(client.estimateFee()).resolves.toEqual(expect.any(Number));
  });

  test('estimateFee clamps non-positive blocks to minimum', async () => {
    await expect(client.estimateFee(0)).resolves.toBeGreaterThanOrEqual(10);
  });
});


