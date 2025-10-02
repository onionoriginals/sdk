import { describe, test, expect } from 'bun:test';
import {
  multikey,
  MULTICODEC_ED25519_PUB_HEADER,
  MULTICODEC_ED25519_PRIV_HEADER,
  MULTICODEC_SECP256K1_PUB_HEADER,
  MULTICODEC_SECP256K1_PRIV_HEADER,
  MULTICODEC_P256_PUB_HEADER,
  MULTICODEC_P256_PRIV_HEADER
} from '../../../src/crypto/Multikey';
import { base58btc } from 'multiformats/bases/base58';

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
    const mb = base58btc.encode(concatBytes(unknownHeader, fakeKey));
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

