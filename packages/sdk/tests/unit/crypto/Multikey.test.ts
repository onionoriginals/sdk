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

  test('decodeMultibase accepts both z-base58btc and u-base64url', () => {
    // Regression: decodeMultibase only accepted the 'z' (base58btc) prefix and
    // threw for 'u' (base64url), even though the CEL structural check accepts a
    // 'u' proofValue. A spec-valid base64url signature therefore passed the
    // structural gate but failed to decode and was rejected as unverifiable.
    const raw = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0xff, 0xaa, 0x55]);

    const zEncoded = multikey.encodeMultibase(raw); // 'z' + base58btc
    expect(zEncoded[0]).toBe('z');
    expect(Array.from(multikey.decodeMultibase(zEncoded))).toEqual(Array.from(raw));

    const uEncoded = 'u' + Buffer.from(raw).toString('base64url');
    expect(Array.from(multikey.decodeMultibase(uEncoded))).toEqual(Array.from(raw));

    // An unsupported multibase prefix still fails closed.
    expect(() => multikey.decodeMultibase('x' + Buffer.from(raw).toString('hex'))).toThrow();

    // Malformed base64url must throw rather than silently decode to empty:
    // Buffer.from(..., 'base64url') drops invalid chars instead of erroring, so
    // the payload is validated first.
    expect(() => multikey.decodeMultibase('u@@@')).toThrow();
    expect(() => multikey.decodeMultibase('u')).toThrow();
    expect(() => multikey.decodeMultibase('u====')).toThrow();
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


describe('Multicodec private-key headers match the multicodec registry', () => {
  // varint encodings of the registry codes:
  // secp256k1-priv 0x1301, p256-priv 0x1306, bls12_381-g2-priv 0x130a
  test('spec varint header values', () => {
    expect(Array.from(MULTICODEC_SECP256K1_PRIV_HEADER)).toEqual([0x81, 0x26]);
    expect(Array.from(MULTICODEC_P256_PRIV_HEADER)).toEqual([0x86, 0x26]);
    expect(Array.from(MULTICODEC_BLS12381_G2_PRIV_HEADER)).toEqual([0x8a, 0x26]);
    expect(Array.from(MULTICODEC_ED25519_PRIV_HEADER)).toEqual([0x80, 0x26]);
  });

  test('spec-encoded secp256k1 private key decodes as Secp256k1, not P256', () => {
    const priv = new Uint8Array(32).fill(9);
    const encoded = 'z' + base58.encode(concatBytes(new Uint8Array([0x81, 0x26]), priv));
    const dec = multikey.decodePrivateKey(encoded);
    expect(dec.type).toBe('Secp256k1');
    expect(Array.from(dec.key)).toEqual(Array.from(priv));
  });

  test('legacy [0x13,0x01] secp256k1 private keys still decode and validate', () => {
    const priv = new Uint8Array(32).fill(5);
    const legacy = 'z' + base58.encode(concatBytes(new Uint8Array([0x13, 0x01]), priv));
    const dec = multikey.decodePrivateKey(legacy);
    expect(dec.type).toBe('Secp256k1');
    expect(Array.from(dec.key)).toEqual(Array.from(priv));
    expect(() => validateMultikeyFormat(legacy, 'Secp256k1', true)).not.toThrow();
  });

  test('round-trip for all private key types with spec headers', () => {
    const priv = new Uint8Array(32).fill(7);
    for (const type of ['Secp256k1', 'P256', 'Bls12381G2'] as const) {
      const encoded = multikey.encodePrivateKey(priv, type);
      const dec = multikey.decodePrivateKey(encoded);
      expect(dec.type).toBe(type);
      expect(() => validateMultikeyFormat(encoded, type, true)).not.toThrow();
    }
  });
});

describe('decode length validation (issue #352)', () => {
  test('decodePublicKey rejects wrong-length key bodies', () => {
    const short = 'z' + base58.encode(concatBytes(MULTICODEC_ED25519_PUB_HEADER, new Uint8Array(16).fill(1)));
    expect(() => multikey.decodePublicKey(short)).toThrow(/32 bytes/);

    const long = 'z' + base58.encode(concatBytes(MULTICODEC_SECP256K1_PUB_HEADER, new Uint8Array(64).fill(1)));
    expect(() => multikey.decodePublicKey(long)).toThrow(/33 bytes/);
  });

  test('decodePrivateKey rejects wrong-length key bodies', () => {
    const short = 'z' + base58.encode(concatBytes(MULTICODEC_ED25519_PRIV_HEADER, new Uint8Array(31).fill(2)));
    expect(() => multikey.decodePrivateKey(short)).toThrow(/32 bytes/);

    const legacyLong = 'z' + base58.encode(concatBytes(new Uint8Array([0x13, 0x01]), new Uint8Array(40).fill(3)));
    expect(() => multikey.decodePrivateKey(legacyLong)).toThrow(/32 bytes/);
  });

  test('correct-length keys still decode for every type', () => {
    expect(multikey.decodePublicKey(multikey.encodePublicKey(new Uint8Array(32).fill(1), 'Ed25519')).type).toBe('Ed25519');
    expect(multikey.decodePublicKey(multikey.encodePublicKey(new Uint8Array(33).fill(1), 'Secp256k1')).type).toBe('Secp256k1');
    expect(multikey.decodePublicKey(multikey.encodePublicKey(new Uint8Array(33).fill(1), 'P256')).type).toBe('P256');
    expect(multikey.decodePublicKey(multikey.encodePublicKey(new Uint8Array(96).fill(1), 'Bls12381G2')).type).toBe('Bls12381G2');
  });
});
