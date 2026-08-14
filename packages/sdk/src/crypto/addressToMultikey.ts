/**
 * Converting a base58 raw-Ed25519-key address into a Multikey (plan 045).
 *
 * Custody backends commonly hand back an *address*, not a Multikey. Turnkey's
 * Ed25519 accounts use `ADDRESS_FORMAT_SOLANA`, whose address is plain base58
 * of the raw 32-byte public key — no multicodec header and no multibase `z`
 * prefix. Building `did:key:${address}` from it therefore produces an
 * identifier that is not a valid did:key at all: the raw key's base58 usually
 * starts with a non-`z` character, and `parseDidKeyVerificationMethod` throws
 * on it.
 *
 * Consumers keep re-deriving this by hand and getting it wrong, so it lives
 * here rather than in an integration package.
 */

import { base58 } from '@scure/base';
import { multikey } from './Multikey.js';
import { StructuredError } from '../utils/telemetry.js';

/**
 * Decodes a base58 raw Ed25519 public-key address (Solana address format) and
 * re-encodes it as a Multikey.
 *
 * @param address - base58 of the raw 32-byte Ed25519 public key
 * @returns the `z…` Multikey form, suitable for `did:key:` and DID documents
 * @throws StructuredError `INVALID_ADDRESS` if it is not base58 of 32 bytes
 *
 * @example
 * ```typescript
 * const mk = base58AddressToEd25519Multikey(account.address);
 * const did = `did:key:${mk}`;                 // a REAL did:key
 * ```
 */
export function base58AddressToEd25519Multikey(address: string): string {
  if (typeof address !== 'string' || address.length === 0) {
    throw new StructuredError('INVALID_ADDRESS', 'Address must be a non-empty base58 string.');
  }
  // A multibase Multikey was passed instead of an address — accept it as-is so
  // callers can hand through whichever form they hold.
  if (address.startsWith('z')) {
    try {
      const decoded = multikey.decodePublicKey(address);
      if (decoded.type === 'Ed25519') return address;
    } catch {
      // Not a Multikey after all; fall through and treat it as an address.
    }
  }

  let raw: Uint8Array;
  try {
    raw = base58.decode(address);
  } catch {
    throw new StructuredError('INVALID_ADDRESS', `Address is not valid base58: ${address}`);
  }
  if (raw.length !== 32) {
    throw new StructuredError(
      'INVALID_ADDRESS',
      `Expected a raw 32-byte Ed25519 public key, got ${raw.length} bytes. ` +
      `An ADDRESS_FORMAT_SOLANA address is base58 of the raw key — not a Multikey, ` +
      `and not a secp256k1 or Bitcoin address.`
    );
  }
  return multikey.encodePublicKey(raw, 'Ed25519');
}
