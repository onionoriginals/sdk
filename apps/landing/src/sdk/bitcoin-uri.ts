/**
 * BIP-21 payment URIs for the deposit address.
 *
 * The point is that nobody transcribes anything: the address and the exact
 * amount travel together into the wallet. A deposit screen that makes someone
 * retype a bech32 address and a sat figure by hand is the screen that produces
 * a shortfall and a confused top-up.
 */

/**
 * Satoshis → the decimal BTC string BIP-21 wants.
 *
 * Built by slicing an integer string, never by dividing. `String(sats / 1e8)`
 * switches to exponential notation under 1e-6 — 1 sat serialises as `1e-8`,
 * which is not a BIP-21 amount and which wallets reject. 99 of the first
 * 300,000 sat values hit that. Integer arithmetic only, all the way to the
 * string.
 */
export function satsToBtcAmount(sats: number): string {
  if (!Number.isFinite(sats) || sats < 0 || !Number.isInteger(sats)) {
    throw new Error(`Not a satoshi amount: ${sats}`);
  }
  const digits = String(sats).padStart(9, '0');
  const whole = digits.slice(0, -8);
  // BIP-21 permits trailing zeros but wallets display the trimmed form.
  const fraction = digits.slice(-8).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * `bitcoin:<address>?amount=<btc>` — the URI a wallet opens prefilled.
 *
 * The address is emitted verbatim, in the case we derived it. Bech32 is
 * case-insensitive only when a string is uniformly cased, so "helpfully"
 * upper-casing it to shrink the QR is a way to produce an address some
 * wallets reject; the few bytes are not worth it.
 */
export function bitcoinPaymentUri(address: string, sats?: number): string {
  if (!address) throw new Error('A payment URI needs an address');
  return sats === undefined ? `bitcoin:${address}` : `bitcoin:${address}?amount=${satsToBtcAmount(sats)}`;
}
