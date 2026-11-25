import { base58 } from '@scure/base';

// Varint multicodec headers (match packages/sdk src/utils/encoding.ts).
const PUBLIC_HEADER = new Uint8Array([0xec, 0x01]);
const PRIVATE_HEADER = new Uint8Array([0x82, 0x26]);
const X25519_PK_LEN = 32;

export function encodeX25519PublicMultikey(publicKey: Uint8Array): string {
  if (publicKey.length !== X25519_PK_LEN) {
    throw new Error('X25519 public key must be 32 bytes');
  }
  const raw = new Uint8Array(PUBLIC_HEADER.length + publicKey.length);
  raw.set(PUBLIC_HEADER, 0);
  raw.set(publicKey, PUBLIC_HEADER.length);
  return `z${base58.encode(raw)}`;
}

export function decodeX25519PublicMultikey(publicKeyMultibase: string): Uint8Array {
  if (!publicKeyMultibase.startsWith('z')) {
    throw new Error('multikey must be base58btc with z prefix');
  }
  const raw = base58.decode(publicKeyMultibase.slice(1));
  if (raw.length !== PUBLIC_HEADER.length + X25519_PK_LEN) {
    throw new Error('invalid X25519 multikey length');
  }
  if (raw[0] !== PUBLIC_HEADER[0] || raw[1] !== PUBLIC_HEADER[1]) {
    throw new Error('invalid X25519 multikey header');
  }
  return raw.subarray(PUBLIC_HEADER.length);
}

export function encodeX25519PrivateMultikey(privateKey: Uint8Array): string {
  if (privateKey.length !== X25519_PK_LEN) {
    throw new Error('X25519 private key must be 32 bytes');
  }
  const raw = new Uint8Array(PRIVATE_HEADER.length + privateKey.length);
  raw.set(PRIVATE_HEADER, 0);
  raw.set(privateKey, PRIVATE_HEADER.length);
  return `z${base58.encode(raw)}`;
}

export function decodeX25519PrivateMultikey(privateKeyMultibase: string): Uint8Array {
  if (!privateKeyMultibase.startsWith('z')) {
    throw new Error('multikey must be base58btc with z prefix');
  }
  const raw = base58.decode(privateKeyMultibase.slice(1));
  if (raw.length !== PRIVATE_HEADER.length + X25519_PK_LEN) {
    throw new Error('invalid X25519 private multikey length');
  }
  if (raw[0] !== PRIVATE_HEADER[0] || raw[1] !== PRIVATE_HEADER[1]) {
    throw new Error('invalid X25519 private multikey header');
  }
  return raw.subarray(PRIVATE_HEADER.length);
}