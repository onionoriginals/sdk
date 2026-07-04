import { describe, test, expect } from 'bun:test';
import { PSBTBuilder } from '../../../src/bitcoin/PSBTBuilder';

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
      utxos: [utxo('a', 0, 1_000)],
      outputs: [{ address: 'to', value: 600 }],
      changeAddress: 'change',
      feeRate: 1,
      network: 'regtest'
    });
    expect(res.changeOutput).toBeUndefined();
    // 1 input, 1 output → 109 vbytes at 1 sat/vB; the sub-dust remainder is
    // folded into the fee: 1000 - 600 = 400.
    expect(res.fee).toBe(400);
  });

  test('throws when inputs cover outputs but not the fee', () => {
    const b = new PSBTBuilder();
    // 700 covers the 600 output but not 600 + 109 fee at 1 sat/vB.
    expect(() => b.build({
      utxos: [utxo('a', 0, 700)],
      outputs: [{ address: 'to', value: 600 }],
      changeAddress: 'change',
      feeRate: 1,
      network: 'regtest'
    })).toThrow('Insufficient funds');
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


describe('PSBTBuilder ordinal safety (issue #249)', () => {
  const utxo = (txid: string, vout: number, value: number, extra: Record<string, unknown> = {}) =>
    ({ txid, vout, value, ...extra });

  test('never selects inscription-bearing, resource, or locked UTXOs by default', () => {
    const b = new PSBTBuilder();
    // 546-sat inscribed UTXO is the smallest — the old ascending greedy
    // selection would have spent it first.
    const res = b.build({
      utxos: [
        utxo('inscribed', 0, 546, { inscriptions: ['abci0'] }),
        utxo('resource', 0, 800, { hasResource: true }),
        utxo('locked', 0, 900, { locked: true }),
        utxo('clean', 0, 100_000)
      ],
      outputs: [{ address: 'to', value: 50_000 }],
      changeAddress: 'change',
      feeRate: 1,
      network: 'regtest'
    });
    expect(res.selectedUtxos.map(u => u.txid)).toEqual(['clean']);
  });

  test('throws when only protected UTXOs are available', () => {
    const b = new PSBTBuilder();
    expect(() => b.build({
      utxos: [utxo('inscribed', 0, 100_000, { inscriptions: ['abci0'] })],
      outputs: [{ address: 'to', value: 1_000 }],
      changeAddress: 'change',
      feeRate: 1,
      network: 'regtest'
    })).toThrow(/inscriptions\/resources or are locked/);
  });

  test('allowOrdinalUtxos: true opts back in', () => {
    const b = new PSBTBuilder();
    const res = b.build({
      utxos: [utxo('inscribed', 0, 100_000, { inscriptions: ['abci0'] })],
      outputs: [{ address: 'to', value: 1_000 }],
      changeAddress: 'change',
      feeRate: 1,
      network: 'regtest',
      allowOrdinalUtxos: true
    });
    expect(res.selectedUtxos.map(u => u.txid)).toEqual(['inscribed']);
  });
});
