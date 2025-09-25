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

  test('getSatInfo returns inscription ids when satoshi is non-zero', async () => {
    const info = await client.getSatInfo('123');
    expect(Array.isArray(info.inscription_ids)).toBe(true);
    expect(info.inscription_ids[0]).toBe('insc-123');
  });

  test('getSatInfo returns empty for zero-like input', async () => {
    const info = await client.getSatInfo('0');
    expect(info.inscription_ids).toEqual([]);
  });

  test('resolveInscription by inscription id yields inscription', async () => {
    const insc = await client.resolveInscription('insc-777');
    expect(insc).not.toBeNull();
    expect(insc!.inscriptionId).toBe('insc-777');
    expect(insc!.satoshi).toBe('777');
  });

  test('resolveInscription by satoshi yields inscription', async () => {
    const insc = await client.resolveInscription('888');
    expect(insc).not.toBeNull();
    expect(insc!.inscriptionId).toBe('insc-888');
    expect(insc!.satoshi).toBe('888');
  });

  test('getMetadata returns deterministic object keyed by id', async () => {
    const meta = await client.getMetadata('insc-abc');
    expect(meta).toEqual(expect.objectContaining({ id: 'insc-abc' }));
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


