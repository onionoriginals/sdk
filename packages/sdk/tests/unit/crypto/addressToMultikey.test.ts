/**
 * Plan 045: turning a custody backend's ADDRESS into a Multikey.
 *
 * Turnkey's Ed25519 accounts use ADDRESS_FORMAT_SOLANA — base58 of the raw
 * 32-byte public key, with no multicodec header and no multibase prefix.
 * Consumers kept building `did:key:${address}` from it, which is not a valid
 * did:key at all.
 */

import { describe, test, expect } from 'bun:test';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58AddressToEd25519Multikey } from '../../../src/crypto/addressToMultikey';
import { multikey } from '@originals/cel';

describe('base58AddressToEd25519Multikey', () => {
  const publicKey = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const solanaAddress = base58.encode(publicKey);
  const expected = multikey.encodePublicKey(publicKey, 'Ed25519');

  test('converts a Solana-format address to the Multikey for the same key', () => {
    expect(base58AddressToEd25519Multikey(solanaAddress)).toBe(expected);
  });

  test('the result round-trips back to the original public key', () => {
    const decoded = multikey.decodePublicKey(base58AddressToEd25519Multikey(solanaAddress));
    expect(decoded.type).toBe('Ed25519');
    expect(Buffer.from(decoded.key).toString('hex')).toBe(Buffer.from(publicKey).toString('hex'));
  });

  test('the raw address is NOT itself a usable Multikey — the bug this prevents', () => {
    // Why the helper exists: did:key:<address> is not a did:key.
    expect(() => multikey.decodePublicKey(solanaAddress)).toThrow();
  });

  test('an existing Ed25519 Multikey passes through unchanged', () => {
    expect(base58AddressToEd25519Multikey(expected)).toBe(expected);
  });

  test('rejects a non-32-byte key with a message naming the address format', () => {
    expect(() => base58AddressToEd25519Multikey(base58.encode(new Uint8Array(33)))).toThrow(
      /ADDRESS_FORMAT_SOLANA/
    );
  });

  test('rejects non-base58 and empty input', () => {
    expect(() => base58AddressToEd25519Multikey('not base58!!! 0OIl')).toThrow(/base58/);
    expect(() => base58AddressToEd25519Multikey('')).toThrow(/non-empty/);
  });
});
