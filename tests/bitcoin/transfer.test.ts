import { buildTransferTransaction } from '../../src/bitcoin/transfer';
import { DUST_LIMIT_SATS, Utxo } from '../../src/types';

describe('buildTransferTransaction', () => {
  const utxo = (value: number, i: number = 0): Utxo => ({ txid: 't', vout: i, value });

  test('creates tx with recipient output and change when above dust', () => {
    const { tx, selection } = buildTransferTransaction([utxo(100_000)], 'bc1qto', 50_000, 1);
    expect(tx.vout[0].address).toBe('bc1qto');
    expect(tx.vout[0].value).toBe(50_000);
    expect(selection.changeSats).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
    // change output present when change >= dust
    expect(tx.vout.length).toBe(2);
  });

  test('suppresses change output when below dust threshold', () => {
    const { tx, selection } = buildTransferTransaction([utxo(800)], 'addr', DUST_LIMIT_SATS, 1);
    expect(selection.changeSats).toBe(0);
    // only recipient output
    expect(tx.vout.length).toBe(1);
  });

  test('uses input address as default change address when provided', () => {
    const inputWithAddr: Utxo = { txid: 't', vout: 0, value: 100000, address: 'bc1qchange' };
    const { tx, selection } = buildTransferTransaction([inputWithAddr], 'bc1qto', 50000, 1);
    expect(selection.changeSats).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
    // change output address should be input address when not passed explicitly
    expect(tx.vout[1].address).toBe('bc1qchange');
  });
});