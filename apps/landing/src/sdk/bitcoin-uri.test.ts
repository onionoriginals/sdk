import { describe, test, expect } from 'bun:test';
import { satsToBtcAmount, bitcoinPaymentUri } from './bitcoin-uri';

const ADDRESS = 'bc1qwx77y7n2dvcfy2aejnrxcapevmssfezc4ly4rl';

describe('satoshis convert to BIP-21 BTC without touching a float', () => {
  test.each([
    [0, '0'],
    [1, '0.00000001'],
    [546, '0.00000546'],
    [14_580, '0.0001458'],
    [100_000_000, '1'],
    [123_456_789, '1.23456789'],
    [2_100_000_000_000_000, '21000000'],
  ])('%i sats → %s BTC', (sats, expected) => {
    expect(satsToBtcAmount(sats)).toBe(expected);
  });

  // The actual reason this is built from strings: not precision, but
  // exponential notation. Small amounts serialise as '1e-8', which is not a
  // BIP-21 amount at all. (Division is exact for 14,580 sats — the naive
  // version is wrong for a different reason than it first appears.)
  test('never emits exponential notation, which division does under 1e-6', () => {
    expect(String(1 / 1e8)).toBe('1e-8');
    expect(satsToBtcAmount(1)).toBe('0.00000001');
    for (const sats of [1, 9, 99, 546, 999]) {
      expect(satsToBtcAmount(sats)).not.toContain('e');
    }
  });

  test('refuses anything that is not a whole, non-negative count of sats', () => {
    expect(() => satsToBtcAmount(-1)).toThrow();
    expect(() => satsToBtcAmount(1.5)).toThrow();
    expect(() => satsToBtcAmount(NaN)).toThrow();
  });
});

describe('the payment URI carries the address and the exact amount', () => {
  test('is a BIP-21 URI a wallet opens prefilled', () => {
    expect(bitcoinPaymentUri(ADDRESS, 14_580)).toBe(`bitcoin:${ADDRESS}?amount=0.0001458`);
  });

  test('omits the amount when there is no quote to state', () => {
    expect(bitcoinPaymentUri(ADDRESS)).toBe(`bitcoin:${ADDRESS}`);
  });

  // Upper-casing shrinks the QR but mixed-case bech32 is invalid, and a
  // wallet that rejects the address is worse than a slightly denser code.
  test('preserves the address exactly as derived', () => {
    expect(bitcoinPaymentUri(ADDRESS, 1)).toContain(ADDRESS);
    expect(bitcoinPaymentUri(ADDRESS, 1)).not.toContain(ADDRESS.toUpperCase());
  });

  test('refuses to build a URI with no address', () => {
    expect(() => bitcoinPaymentUri('', 1)).toThrow();
  });
});
