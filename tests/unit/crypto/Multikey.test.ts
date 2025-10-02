import { describe, test, expect } from 'bun:test';
import {
  multikey,
  validateMultikeyFormat,
  MULTICODEC_ED25519_PUB_HEADER,
  MULTICODEC_ED25519_PRIV_HEADER,
  MULTICODEC_SECP256K1_PUB_HEADER,
  MULTICODEC_SECP256K1_PRIV_HEADER,
  MULTICODEC_P256_PUB_HEADER,
  MULTICODEC_P256_PRIV_HEADER,
  MULTICODEC_BLS12381_G2_PUB_HEADER,
  MULTICODEC_BLS12381_G2_PRIV_HEADER
} from '../../../src/crypto/Multikey';
import { base58 } from '@scure/base';

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe('Multikey encode/decode', () => {
  const edPub = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
  const edPriv = new Uint8Array(32).map((_, i) => (i + 2) & 0xff);
  const secpPub = new Uint8Array(33).map((_, i) => (i + 3) & 0xff);
  const secpPriv = new Uint8Array(32).map((_, i) => (i + 4) & 0xff);
  const p256Pub = new Uint8Array(33).map((_, i) => (i + 7) & 0xff);
  const p256Priv = new Uint8Array(32).map((_, i) => (i + 8) & 0xff);

  test('encode/decode Ed25519', () => {
    const pub = multikey.encodePublicKey(edPub, 'Ed25519');
    const priv = multikey.encodePrivateKey(edPriv, 'Ed25519');
    const decPub = multikey.decodePublicKey(pub);
    const decPriv = multikey.decodePrivateKey(priv);
    expect(Array.from(decPub.key)).toEqual(Array.from(edPub));
    expect(decPub.type).toBe('Ed25519');
    expect(Array.from(decPriv.key)).toEqual(Array.from(edPriv));
    expect(decPriv.type).toBe('Ed25519');
  });

  test('encode/decode Secp256k1', () => {
    const pub = multikey.encodePublicKey(secpPub, 'Secp256k1');
    const priv = multikey.encodePrivateKey(secpPriv, 'Secp256k1');
    const decPub = multikey.decodePublicKey(pub);
    const decPriv = multikey.decodePrivateKey(priv);
    expect(Array.from(decPub.key)).toEqual(Array.from(secpPub));
    expect(decPub.type).toBe('Secp256k1');
    expect(Array.from(decPriv.key)).toEqual(Array.from(secpPriv));
    expect(decPriv.type).toBe('Secp256k1');
  });

  test('encode/decode P256', () => {
    const pub = multikey.encodePublicKey(p256Pub, 'P256');
    const priv = multikey.encodePrivateKey(p256Priv, 'P256');
    const decPub = multikey.decodePublicKey(pub);
    const decPriv = multikey.decodePrivateKey(priv);
    expect(Array.from(decPub.key)).toEqual(Array.from(p256Pub));
    expect(decPub.type).toBe('P256');
    expect(Array.from(decPriv.key)).toEqual(Array.from(p256Priv));
    expect(decPriv.type).toBe('P256');
  });

  test('decode errors: invalid multibase prefix', () => {
    expect(() => multikey.decodePublicKey('xabc')).toThrow();
    expect(() => multikey.decodePrivateKey('xabc')).toThrow();
  });

  test('decode errors: unsupported type header', () => {
    const unknownHeader = new Uint8Array([0x00, 0x00]);
    const fakeKey = new Uint8Array([1, 2, 3, 4]);
    const mb = 'z' + base58.encode(concatBytes(unknownHeader, fakeKey));
    expect(() => multikey.decodePublicKey(mb)).toThrow('Unsupported key type');
    expect(() => multikey.decodePrivateKey(mb)).toThrow('Unsupported key type');
  });

  test('encode/decode Bls12381G2', () => {
    const blsPub = new Uint8Array(96).map((_, i) => (i + 5) & 0xff);
    const blsPriv = new Uint8Array(32).map((_, i) => (i + 6) & 0xff);
    const pub = multikey.encodePublicKey(blsPub, 'Bls12381G2');
    const priv = multikey.encodePrivateKey(blsPriv, 'Bls12381G2');
    const decPub = multikey.decodePublicKey(pub);
    const decPriv = multikey.decodePrivateKey(priv);
    expect(Array.from(decPub.key)).toEqual(Array.from(blsPub));
    expect(decPub.type).toBe('Bls12381G2');
    expect(Array.from(decPriv.key)).toEqual(Array.from(blsPriv));
    expect(decPriv.type).toBe('Bls12381G2');
  });
});

describe('validateMultikeyFormat', () => {
  test('throws on null/undefined key', () => {
    expect(() => validateMultikeyFormat(null as any, 'Ed25519', false)).toThrow('Invalid multibase key format. Key must be a non-empty string.');
    expect(() => validateMultikeyFormat(undefined as any, 'Ed25519', false)).toThrow('Invalid multibase key format. Key must be a non-empty string.');
  });

  test('throws on empty string', () => {
    expect(() => validateMultikeyFormat('', 'Ed25519', false)).toThrow('Invalid multibase key format. Key must be a non-empty string.');
  });

  test('throws on non-z prefix', () => {
    expect(() => validateMultikeyFormat('xABC123', 'Ed25519', false)).toThrow('Invalid multibase key format. Keys must use z-base58btc encoding (prefix "z").');
  });

  test('throws on invalid base58 decode', () => {
    expect(() => validateMultikeyFormat('z!!!', 'Ed25519', false)).toThrow('Invalid multibase key format. Keys must use multicodec headers. Decode error:');
  });

  test('throws when decoded length is less than 2 bytes', () => {
    const shortEncoded = 'z' + base58.encode(new Uint8Array([0x01]));
    expect(() => validateMultikeyFormat(shortEncoded, 'Ed25519', false)).toThrow('Invalid multibase key format. Keys must use multicodec headers.');
  });

  test('throws on mismatched Ed25519 public key header', () => {
    // Wrong header for Ed25519
    const wrongHeader = new Uint8Array([0x00, 0x00]);
    const fakeKey = new Uint8Array(32).fill(1);
    const encoded = 'z' + base58.encode(concatBytes(wrongHeader, fakeKey));
    expect(() => validateMultikeyFormat(encoded, 'Ed25519', false)).toThrow('Invalid multibase key format. Expected Ed25519 public key');
  });

  test('throws on mismatched Ed25519 private key header', () => {
    const wrongHeader = new Uint8Array([0x00, 0x00]);
    const fakeKey = new Uint8Array(32).fill(1);
    const encoded = 'z' + base58.encode(concatBytes(wrongHeader, fakeKey));
    expect(() => validateMultikeyFormat(encoded, 'Ed25519', true)).toThrow('Invalid multibase key format. Expected Ed25519 private key');
  });

  test('throws on wrong Ed25519 public key length', () => {
    const pub = new Uint8Array(31).fill(1); // Should be 32
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_ED25519_PUB_HEADER, pub));
    expect(() => validateMultikeyFormat(encoded, 'Ed25519', false)).toThrow('Invalid multibase key format. Expected Ed25519 public key to be 32 bytes');
  });

  test('throws on wrong Ed25519 private key length', () => {
    const priv = new Uint8Array(31).fill(1); // Should be 32
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_ED25519_PRIV_HEADER, priv));
    expect(() => validateMultikeyFormat(encoded, 'Ed25519', true)).toThrow('Invalid multibase key format. Expected Ed25519 private key to be 32 bytes');
  });

  test('validates correct Ed25519 public key', () => {
    const pub = new Uint8Array(32).fill(1);
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_ED25519_PUB_HEADER, pub));
    expect(() => validateMultikeyFormat(encoded, 'Ed25519', false)).not.toThrow();
  });

  test('validates correct Ed25519 private key', () => {
    const priv = new Uint8Array(32).fill(1);
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_ED25519_PRIV_HEADER, priv));
    expect(() => validateMultikeyFormat(encoded, 'Ed25519', true)).not.toThrow();
  });

  test('validates correct Secp256k1 public key (33 bytes)', () => {
    const pub = new Uint8Array(33).fill(2);
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_SECP256K1_PUB_HEADER, pub));
    expect(() => validateMultikeyFormat(encoded, 'Secp256k1', false)).not.toThrow();
  });

  test('validates correct Secp256k1 private key (32 bytes)', () => {
    const priv = new Uint8Array(32).fill(2);
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_SECP256K1_PRIV_HEADER, priv));
    expect(() => validateMultikeyFormat(encoded, 'Secp256k1', true)).not.toThrow();
  });

  test('throws on wrong Secp256k1 public key length', () => {
    const pub = new Uint8Array(32).fill(2); // Should be 33
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_SECP256K1_PUB_HEADER, pub));
    expect(() => validateMultikeyFormat(encoded, 'Secp256k1', false)).toThrow('Invalid multibase key format. Expected Secp256k1 public key to be 33 bytes');
  });

  test('validates correct P256 public key (33 bytes)', () => {
    const pub = new Uint8Array(33).fill(3);
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_P256_PUB_HEADER, pub));
    expect(() => validateMultikeyFormat(encoded, 'P256', false)).not.toThrow();
  });

  test('validates correct P256 private key (32 bytes)', () => {
    const priv = new Uint8Array(32).fill(3);
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_P256_PRIV_HEADER, priv));
    expect(() => validateMultikeyFormat(encoded, 'P256', true)).not.toThrow();
  });

  test('validates correct Bls12381G2 public key (96 bytes)', () => {
    const pub = new Uint8Array(96).fill(4);
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_BLS12381_G2_PUB_HEADER, pub));
    expect(() => validateMultikeyFormat(encoded, 'Bls12381G2', false)).not.toThrow();
  });

  test('validates correct Bls12381G2 private key (32 bytes)', () => {
    const priv = new Uint8Array(32).fill(4);
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_BLS12381_G2_PRIV_HEADER, priv));
    expect(() => validateMultikeyFormat(encoded, 'Bls12381G2', true)).not.toThrow();
  });

  test('throws on wrong Bls12381G2 public key length', () => {
    const pub = new Uint8Array(95).fill(4); // Should be 96
    const encoded = 'z' + base58.encode(concatBytes(MULTICODEC_BLS12381_G2_PUB_HEADER, pub));
    expect(() => validateMultikeyFormat(encoded, 'Bls12381G2', false)).toThrow('Invalid multibase key format. Expected Bls12381G2 public key to be 96 bytes');
  });

  test('re-throws validation errors as-is', () => {
    // This tests the error re-throwing logic for errors that start with "Invalid multibase key format"
    expect(() => validateMultikeyFormat('', 'Ed25519', false)).toThrow('Invalid multibase key format. Key must be a non-empty string.');
  });
});

