import { PSBTBuilder } from '../../src/bitcoin/PSBTBuilder';

describe('PSBTBuilder', () => {
  const utxo = (txid: string, vout: number, value: number) => ({ txid, vout, value });

  test('throws on no UTXOs', () => {
    const b = new PSBTBuilder();
    expect(() => b.build({ utxos: [], outputs: [{ address: 'addr', value: 1_000 }], changeAddress: 'change', feeRate: 1, network: 'regtest' })).toThrow('No UTXOs');
  });

  test('throws on no outputs', () => {
    const b = new PSBTBuilder();
    expect(() => b.build({ utxos: [utxo('t', 0, 1000)], outputs: [], changeAddress: 'change', feeRate: 1, network: 'regtest' })).toThrow('No outputs');
  });

  test('throws on insufficient funds', () => {
    const b = new PSBTBuilder();
    expect(() => b.build({
      utxos: [utxo('a', 0, 500)],
      outputs: [{ address: 'to', value: 600 }],
      changeAddress: 'change',
      feeRate: 1,
      network: 'regtest'
    })).toThrow('Insufficient funds');
  });

  test('includes change when change >= dust', () => {
    const b = new PSBTBuilder();
    const res = b.build({
      utxos: [
        // Intentionally unsorted to exercise comparator function
        utxo('b', 1, 2_000),
        utxo('a', 0, 10_000)
      ],
      outputs: [{ address: 'to', value: 1_000 }],
      changeAddress: 'change',
      feeRate: 1,
      network: 'regtest'
    });
    expect(res.selectedUtxos.length).toBe(1);
    expect(res.changeOutput).toBeDefined();
    expect(res.fee).toBeGreaterThan(0);
    // decode psbt-like payload for sanity
    const json = Buffer.from(res.psbtBase64, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    expect(payload.outputs.some((o: any) => o.address === 'change')).toBe(true);
  });

  test('adds dust to fee when change < dust', () => {
    const b = new PSBTBuilder();
    const res = b.build({
      utxos: [utxo('a', 0, 700)],
      outputs: [{ address: 'to', value: 600 }],
      changeAddress: 'change',
      feeRate: 1,
      network: 'regtest'
    });
    expect(res.changeOutput).toBeUndefined();
    expect(res.fee).toBe(100);
  });

  test('falls back when Buffer/btoa not available', () => {
    const b = new PSBTBuilder();
    const originalBuffer = (global as any).Buffer;
    const originalBtoa = (global as any).btoa;
    (global as any).Buffer = undefined;
    (global as any).btoa = undefined;
    try {
      const res = b.build({
        utxos: [utxo('a', 0, 10_000)],
        outputs: [{ address: 'to', value: 1_000 }],
        changeAddress: 'change',
        feeRate: 1,
        network: 'regtest'
      });
      expect(res.psbtBase64.startsWith('psbt:')).toBe(true);
    } finally {
      (global as any).Buffer = originalBuffer;
      (global as any).btoa = originalBtoa;
    }
  });
});

