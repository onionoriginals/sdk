import { encoding } from '@originals/sdk';

const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

// Turnkey ed25519 accounts use ADDRESS_FORMAT_SOLANA: the address is base58btc
// of the raw 32-byte public key (no multibase prefix). Convert to a Multikey
// publicKeyMultibase string ('z' + base58btc(0xed01 || rawKey)).
export function solanaAddressToEd25519Multibase(address: string): string {
  // encoding.multibase.decode requires a leading multibase code and strips it;
  // Solana addresses omit it, so re-add the base58btc 'z' code before decoding.
  const raw = encoding.multibase.decode(`z${address}`);
  if (raw.length !== 32) throw new Error(`Expected 32-byte ed25519 key, got ${raw.length}`);
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + raw.length);
  prefixed.set(ED25519_MULTICODEC);
  prefixed.set(raw, ED25519_MULTICODEC.length);
  return encoding.multibase.encode(prefixed, 'base58btc');
}
