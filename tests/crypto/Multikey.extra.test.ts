import { multikey, MULTICODEC_ED25519_PUB_HEADER, MULTICODEC_ED25519_PRIV_HEADER, MULTICODEC_SECP256K1_PUB_HEADER, MULTICODEC_SECP256K1_PRIV_HEADER } from '../../src/crypto/Multikey';
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

  test('encode handles empty input gracefully (leading zero count path)', () => {
    const mb = (multikey as any).encodePublicKey(new Uint8Array([0, 0, 1]), 'Ed25519');
    expect(typeof mb).toBe('string');
    expect(mb[0]).toBe('z');
  });

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

  test('decode errors: invalid multibase prefix', () => {
    expect(() => multikey.decodePublicKey('xabc')).toThrow('Invalid Multibase encoding');
    expect(() => multikey.decodePrivateKey('xabc')).toThrow('Invalid Multibase encoding');
  });

  test('decode errors: invalid base58 character', () => {
    expect(() => multikey.decodePublicKey('z0')).toThrow();
  });

  test('decode errors: empty payload (z only) hits empty branch', () => {
    expect(() => multikey.decodePublicKey('z')).toThrow('Unsupported key type');
    expect(() => multikey.decodePrivateKey('z')).toThrow('Unsupported key type');
  });

  test('decode errors: unsupported type header', () => {
    const unknownHeader = new Uint8Array([0x00, 0x00]);
    const fakeKey = new Uint8Array([1, 2, 3, 4]);
    const mb = base58btc.encode(concatBytes(unknownHeader, fakeKey));
    expect(() => multikey.decodePublicKey(mb)).toThrow('Unsupported key type');
    expect(() => multikey.decodePrivateKey(mb)).toThrow('Unsupported key type');
  });
});

