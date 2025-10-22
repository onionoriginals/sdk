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

  test('getInscriptionById returns null for non-existent id', async () => {
    const prov = new OrdMockProvider();
    const inscription = await prov.getInscriptionById('non-existent');
    expect(inscription).toBeNull();
  });

  test('getInscriptionsBySatoshi returns empty array for non-existent satoshi', async () => {
    const prov = new OrdMockProvider();
    const inscriptions = await prov.getInscriptionsBySatoshi('999999');
    expect(inscriptions).toEqual([]);
  });

  test('getInscriptionsBySatoshi returns list of inscriptions for satoshi', async () => {
    const prov = new OrdMockProvider();
    const data = Buffer.from('test data');
    const res = await prov.createInscription({ data, contentType: 'text/plain' });
    
    // Get the satoshi from the created inscription
    const inscriptions = await prov.getInscriptionsBySatoshi(res.satoshi!);
    expect(inscriptions.length).toBeGreaterThan(0);
    expect(inscriptions[0].inscriptionId).toBe(res.inscriptionId);
  });

  test('createInscription with custom feeRate', async () => {
    const prov = new OrdMockProvider();
    const data = Buffer.from('test data');
    const res = await prov.createInscription({ 
      data, 
      contentType: 'text/plain',
      feeRate: 15 
    });
    expect(res.feeRate).toBe(15);
  });

  test('createInscription returns all expected fields', async () => {
    const prov = new OrdMockProvider();
    const data = Buffer.from('test data');
    const res = await prov.createInscription({ data, contentType: 'text/plain' });
    
    expect(res.inscriptionId).toBeDefined();
    expect(res.revealTxId).toBeDefined();
    expect(res.commitTxId).toBeUndefined();
    expect(res.satoshi).toBeDefined();
    expect(res.txid).toBeDefined();
    expect(res.vout).toBe(0);
    expect(res.blockHeight).toBe(1);
    expect(res.content).toEqual(data);
    expect(res.contentType).toBe('text/plain');
  });

  test('transferInscription returns proper transaction details', async () => {
    const prov = new OrdMockProvider();
    const data = Buffer.from('test data');
    const res = await prov.createInscription({ data, contentType: 'text/plain' });
    
    const transfer = await prov.transferInscription(res.inscriptionId, 'bc1qaddress', { feeRate: 10 });
    
    expect(transfer.txid).toBeDefined();
    expect(transfer.vin).toBeDefined();
    expect(transfer.vin.length).toBeGreaterThan(0);
    expect(transfer.vin[0].txid).toBe(res.txid);
    expect(transfer.vin[0].vout).toBe(res.vout);
    expect(transfer.vout).toBeDefined();
    expect(transfer.vout[0].value).toBe(546);
    expect(transfer.vout[0].scriptPubKey).toBe('script');
    expect(transfer.fee).toBe(100);
    expect(transfer.blockHeight).toBe(1);
    expect(transfer.confirmations).toBe(0);
    expect(transfer.satoshi).toBe(res.satoshi);
  });

  test('transferInscription without options', async () => {
    const prov = new OrdMockProvider();
    const data = Buffer.from('test data');
    const res = await prov.createInscription({ data, contentType: 'text/plain' });
    
    const transfer = await prov.transferInscription(res.inscriptionId, 'bc1qaddress');
    
    expect(transfer.txid).toBeDefined();
  });

  test('constructor with partial state including inscriptionsBySatoshi', async () => {
    const inscriptionsBySatoshi = new Map();
    inscriptionsBySatoshi.set('12345', ['insc-1', 'insc-2']);
    
    const prov = new OrdMockProvider({
      inscriptionsBySatoshi,
      feeRate: 8
    });

    const inscriptions = await prov.getInscriptionsBySatoshi('12345');
    expect(inscriptions.length).toBe(2);
    expect(inscriptions[0].inscriptionId).toBe('insc-1');
    expect(inscriptions[1].inscriptionId).toBe('insc-2');
  });

  test('createInscription generates numeric satoshi identifier', async () => {
    const prov = new OrdMockProvider();
    const data = Buffer.from('test');
    const res = await prov.createInscription({ data, contentType: 'text/plain' });
    
    // Verify satoshi is numeric
    expect(res.satoshi).toBeDefined();
    expect(Number.isNaN(Number(res.satoshi))).toBe(false);
    expect(Number(res.satoshi!)).toBeGreaterThan(0);
  });
});

