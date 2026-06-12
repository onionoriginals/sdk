import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { buildTransferTransaction } from '../../../src/bitcoin/transfer';
import { DUST_LIMIT_SATS, Utxo } from '../../../src/types';

// Real-form addresses used as fixtures.
// Mainnet P2WPKH (from BIP-173 test vector)
const MAINNET_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
// Second mainnet address (different hash, used as change)
const MAINNET_CHANGE_ADDR = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
// Testnet/signet P2WPKH (BIP-173 test vector)
const TESTNET_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('buildTransferTransaction', () => {
  const utxo = (value: number, i: number = 0): Utxo => ({ txid: 't'.repeat(64), vout: i, value });
  const utxoWithAddr = (value: number, addr: string, i: number = 0): Utxo => ({
    txid: 't'.repeat(64),
    vout: i,
    value,
    address: addr
  });

  // ── Original behaviours (adapted) ─────────────────────────────────────────

  test('creates tx with recipient output and change when above dust', () => {
    const { tx, selection } = buildTransferTransaction(
      [utxoWithAddr(100_000, MAINNET_CHANGE_ADDR)],
      MAINNET_ADDR,
      50_000,
      1
    );
    expect(tx.vout[0].address).toBe(MAINNET_ADDR);
    expect(tx.vout[0].value).toBe(50_000);
    expect(selection.changeSats).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
    // change output present when change >= dust
    expect(tx.vout.length).toBe(2);
  });

  test('suppresses change output when below dust threshold', () => {
    // Use exactly DUST_LIMIT_SATS as the send amount so the fee eats the remainder
    const { tx, selection } = buildTransferTransaction(
      [utxoWithAddr(800, MAINNET_CHANGE_ADDR)],
      MAINNET_ADDR,
      DUST_LIMIT_SATS,
      1
    );
    expect(selection.changeSats).toBe(0);
    // only recipient output
    expect(tx.vout.length).toBe(1);
  });

  test('uses input address as default change address when provided', () => {
    const inputWithAddr = utxoWithAddr(100_000, MAINNET_CHANGE_ADDR);
    const { tx, selection } = buildTransferTransaction(
      [inputWithAddr],
      MAINNET_ADDR,
      50_000,
      1
    );
    expect(selection.changeSats).toBeGreaterThanOrEqual(DUST_LIMIT_SATS);
    // change output address should be the input address when not explicitly passed
    expect(tx.vout[1].address).toBe(MAINNET_CHANGE_ADDR);
  });

  // ── scriptPubKey correctness ───────────────────────────────────────────────

  test('recipient scriptPubKey is valid hex and round-trips via btc-signer', () => {
    const { tx } = buildTransferTransaction(
      [utxoWithAddr(100_000, MAINNET_CHANGE_ADDR)],
      MAINNET_ADDR,
      50_000,
      1
    );
    const recipientOut = tx.vout[0];

    // Must be a non-empty hex string, not the old placeholder 'script'
    expect(recipientOut.scriptPubKey).not.toBe('script');
    expect(recipientOut.scriptPubKey.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/i.test(recipientOut.scriptPubKey)).toBe(true);

    // Round-trip: decode script → address must equal original address
    const scriptBytes = Buffer.from(recipientOut.scriptPubKey, 'hex');
    const decoded = btc.OutScript.decode(scriptBytes);
    const roundTripped = btc.Address(btc.NETWORK).encode(decoded);
    expect(roundTripped).toBe(MAINNET_ADDR);
  });

  test('change scriptPubKey is valid hex and round-trips via btc-signer', () => {
    const { tx } = buildTransferTransaction(
      [utxoWithAddr(100_000, MAINNET_CHANGE_ADDR)],
      MAINNET_ADDR,
      50_000,
      1
    );
    expect(tx.vout.length).toBe(2);
    const changeOut = tx.vout[1];

    expect(changeOut.scriptPubKey).not.toBe('script');
    expect(/^[0-9a-f]+$/i.test(changeOut.scriptPubKey)).toBe(true);

    const scriptBytes = Buffer.from(changeOut.scriptPubKey, 'hex');
    const decoded = btc.OutScript.decode(scriptBytes);
    const roundTripped = btc.Address(btc.NETWORK).encode(decoded);
    expect(roundTripped).toBe(MAINNET_CHANGE_ADDR);
  });

  // ── Missing changeAddress guard ────────────────────────────────────────────

  test('throws when change >= dust and no change address can be resolved', () => {
    // UTXO with no address field — change needed but no source for change address
    const bareUtxo = utxo(100_000);
    expect(() =>
      buildTransferTransaction([bareUtxo], MAINNET_ADDR, 50_000, 1)
    ).toThrow(/changeAddress is required/);
  });

  // ── Invalid address rejection ──────────────────────────────────────────────

  test('throws on invalid recipient address', () => {
    expect(() =>
      buildTransferTransaction([utxoWithAddr(100_000, MAINNET_CHANGE_ADDR)], 'not-an-address', 50_000, 1)
    ).toThrow();
  });

  test('throws on invalid explicit changeAddress', () => {
    expect(() =>
      buildTransferTransaction(
        [utxoWithAddr(100_000, MAINNET_CHANGE_ADDR)],
        MAINNET_ADDR,
        50_000,
        1,
        { changeAddress: 'bad-change-addr' }
      )
    ).toThrow();
  });

  // ── Network option ─────────────────────────────────────────────────────────

  test('accepts testnet addresses with network: testnet', () => {
    const testnetInput = utxoWithAddr(100_000, TESTNET_ADDR);
    const { tx } = buildTransferTransaction(
      [testnetInput],
      TESTNET_ADDR,
      50_000,
      1,
      { network: 'testnet', changeAddress: TESTNET_ADDR }
    );
    expect(tx.vout[0].address).toBe(TESTNET_ADDR);
    expect(tx.vout[0].scriptPubKey).not.toBe('script');
    expect(/^[0-9a-f]+$/i.test(tx.vout[0].scriptPubKey)).toBe(true);
  });
});
