import { describe, test, expect } from 'bun:test';
import { encoding } from '@originals/sdk';
import { solanaAddressToEd25519Multibase } from '../multibase';

describe('solanaAddressToEd25519Multibase', () => {
  test('round-trips a known 32-byte key through base58', () => {
    const raw = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
    // Solana address is base58btc of the raw key WITHOUT multibase prefix.
    const solanaAddress = encoding.multibase.encode(raw, 'base58btc').slice(1);
    const multibase = solanaAddressToEd25519Multibase(solanaAddress);
    // Multikey = 'z' + base58btc(0xed01 || raw)
    const prefixed = new Uint8Array([0xed, 0x01, ...raw]);
    expect(multibase).toBe(encoding.multibase.encode(prefixed, 'base58btc'));
  });

  test('rejects a key that is not 32 bytes', () => {
    const short = encoding.multibase.encode(new Uint8Array(16), 'base58btc').slice(1);
    expect(() => solanaAddressToEd25519Multibase(short)).toThrow(/32-byte/);
  });
});
