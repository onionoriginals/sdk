import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { ES256KSigner, ES256Signer, Ed25519Signer, Bls12381G2Signer } from '../../../src/crypto/Signer';
import * as secp256k1 from '@noble/secp256k1';
import { p256 } from '@noble/curves/p256';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';

const secpPrivMb = (bytes: Uint8Array) => multikey.encodePrivateKey(bytes, 'Secp256k1');
const secpPubMb = (bytes: Uint8Array) => multikey.encodePublicKey(bytes, 'Secp256k1');
const edPrivMb = (bytes: Uint8Array) => multikey.encodePrivateKey(bytes, 'Ed25519');
const edPubMb = (bytes: Uint8Array) => multikey.encodePublicKey(bytes, 'Ed25519');
const p256PrivMb = (bytes: Uint8Array) => multikey.encodePrivateKey(bytes, 'P256');
const p256PubMb = (bytes: Uint8Array) => multikey.encodePublicKey(bytes, 'P256');
const blsPrivMb = (bytes: Uint8Array) => multikey.encodePrivateKey(bytes, 'Bls12381G2');
const blsPubMb = (bytes: Uint8Array) => multikey.encodePublicKey(bytes, 'Bls12381G2');

describe('Signer abstract class', () => {
  test('abstract class methods are defined', () => {
    // This tests the abstract class definition at lines 1-4
    // Since we can't instantiate an abstract class in TypeScript,
    // we'll verify that the concrete implementations exist
    const signer = new ES256KSigner();
    expect(typeof signer.sign).toBe('function');
    expect(typeof signer.verify).toBe('function');
  });
});

describe('Signer classes', () => {
  const data = Buffer.from('hello world');

  afterEach(() => {
    // Bun automatically restores mocks
  });

  describe('ES256KSigner', () => {
    test('invalid multibase prefix throws on sign and verify', async () => {
      const signer = new ES256KSigner();
      await expect(signer.sign(data, 'xabc')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers.');
      await expect(signer.verify(data, Buffer.alloc(64), 'xabc')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers.');
    });

    test('wrong key type throws on sign and verify', async () => {
      const signer = new ES256KSigner();
      const edPriv = ed25519.utils.randomPrivateKey();
      const edPub = await ed25519.getPublicKey(edPriv);
      await expect(signer.sign(data, edPrivMb(edPriv))).rejects.toThrow('Invalid key type for ES256K');
      await expect(signer.verify(data, Buffer.alloc(64), edPubMb(edPub))).rejects.toThrow('Invalid key type for ES256K');
    });

    test('sign returns bytes path (Uint8Array direct)', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk);
      const signer = new ES256KSigner();
      const sig = await signer.sign(data, secpPrivMb(sk));
      expect(Buffer.isBuffer(sig)).toBe(true);
      const ok = await signer.verify(data, sig, secpPubMb(pk));
      expect(ok).toBe(true);
    });

    test('verify returns false for bad signature', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk);
      const signer = new ES256KSigner();
      const sig = await signer.sign(data, secpPrivMb(sk));
      const bad = Buffer.from(sig);
      bad[0] ^= 0xff;
      const ok = await signer.verify(data, bad, secpPubMb(pk));
      expect(ok).toBe(false);
    });

    test('sign handles object with toCompactRawBytes()', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const signer = new ES256KSigner();
      const bytes = new Uint8Array(64).fill(7);
      spyOn(secp256k1, 'signAsync').mockResolvedValue({
        toCompactRawBytes: () => bytes
      } as any);
      const sig = await signer.sign(data, secpPrivMb(sk));
      expect(Buffer.from(sig)).toEqual(Buffer.from(bytes));
    });

    test('sign handles object with toRawBytes()', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const signer = new ES256KSigner();
      const bytes = new Uint8Array(64).fill(9);
      spyOn(secp256k1, 'signAsync').mockResolvedValue({
        toRawBytes: () => bytes
      } as any);
      const sig = await signer.sign(data, secpPrivMb(sk));
      expect(Buffer.from(sig)).toEqual(Buffer.from(bytes));
    });

    test('sign handles fallback via new Uint8Array(sigAny)', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const signer = new ES256KSigner();
      const arr = Array.from({ length: 64 }, (_, i) => (i + 1) & 0xff);
      spyOn(secp256k1, 'signAsync').mockResolvedValue(arr as any);
      const sig = await signer.sign(data, secpPrivMb(sk));
      expect(sig).toHaveLength(64);
      expect(sig[0]).toBe(1);
      expect(sig[63]).toBe(64);
    });

    test('verify exception path returns false', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk);
      const signer = new ES256KSigner();
      const sig = await signer.sign(data, secpPrivMb(sk));
      const spy = spyOn(secp256k1, 'verify').mockImplementation(() => { throw new Error('boom'); });
      const ok = await signer.verify(data, sig, secpPubMb(pk));
      expect(ok).toBe(false);
      spy.mockRestore();
    });
  });

  describe('ES256Signer', () => {
    test('invalid multibase prefix throws on sign and verify', async () => {
      const signer = new ES256Signer();
      await expect(signer.sign(data, 'xabc')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers.');
      await expect(signer.verify(data, Buffer.alloc(64), 'xabc')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers.');
    });

    test('wrong key type throws on sign and verify', async () => {
      const signer = new ES256Signer();
      const edPriv = ed25519.utils.randomPrivateKey();
      const edPub = await ed25519.getPublicKey(edPriv);
      await expect(signer.sign(data, edPrivMb(edPriv))).rejects.toThrow('Invalid key type for ES256');
      await expect(signer.verify(data, Buffer.alloc(64), edPubMb(edPub))).rejects.toThrow('Invalid key type for ES256');
    });

    test('sign returns bytes path (Uint8Array direct)', async () => {
      const sk = p256.utils.randomPrivateKey();
      const pk = p256.getPublicKey(sk);
      const signer = new ES256Signer();
      const sig = await signer.sign(data, p256PrivMb(sk));
      expect(Buffer.isBuffer(sig)).toBe(true);
      const ok = await signer.verify(data, sig, p256PubMb(pk));
      expect(ok).toBe(true);
    });

    test('verify returns false for bad signature', async () => {
      const sk = p256.utils.randomPrivateKey();
      const pk = p256.getPublicKey(sk);
      const signer = new ES256Signer();
      const sig = await signer.sign(data, p256PrivMb(sk));
      const bad = Buffer.from(sig);
      bad[0] ^= 0xff;
      const ok = await signer.verify(data, bad, p256PubMb(pk));
      expect(ok).toBe(false);
    });

    test('sign handles object with toCompactRawBytes()', async () => {
      const sk = p256.utils.randomPrivateKey();
      const signer = new ES256Signer();
      const bytes = new Uint8Array(64).fill(11);
      const spy = spyOn(p256, 'sign').mockReturnValue({
        toCompactRawBytes: () => bytes
      } as any);
      const sig = await signer.sign(data, p256PrivMb(sk));
      expect(Buffer.from(sig)).toEqual(Buffer.from(bytes));
      spy.mockRestore();
    });

    test('sign handles object with toRawBytes()', async () => {
      const sk = p256.utils.randomPrivateKey();
      const signer = new ES256Signer();
      const bytes = new Uint8Array(64).fill(13);
      const spy = spyOn(p256, 'sign').mockReturnValue({
        toRawBytes: () => bytes
      } as any);
      const sig = await signer.sign(data, p256PrivMb(sk));
      expect(Buffer.from(sig)).toEqual(Buffer.from(bytes));
      spy.mockRestore();
    });

    test('sign handles direct Uint8Array return', async () => {
      const sk = p256.utils.randomPrivateKey();
      const signer = new ES256Signer();
      const bytes = new Uint8Array(64).fill(21);
      const spy = spyOn(p256, 'sign').mockReturnValue(bytes as any);
      const sig = await signer.sign(data, p256PrivMb(sk));
      expect(Buffer.from(sig)).toEqual(Buffer.from(bytes));
      spy.mockRestore();
    });

    test('sign handles fallback via new Uint8Array(sigAny)', async () => {
      const sk = p256.utils.randomPrivateKey();
      const signer = new ES256Signer();
      const arr = Array.from({ length: 64 }, (_, i) => (i + 1) & 0xff);
      const spy = spyOn(p256, 'sign').mockReturnValue(arr as any);
      const sig = await signer.sign(data, p256PrivMb(sk));
      expect(sig).toHaveLength(64);
      expect(sig[0]).toBe(1);
      expect(sig[63]).toBe(64);
      spy.mockRestore();
    });

    test('verify exception path returns false', async () => {
      const sk = p256.utils.randomPrivateKey();
      const pk = p256.getPublicKey(sk);
      const signer = new ES256Signer();
      const sig = await signer.sign(data, p256PrivMb(sk));
      const spy = spyOn(p256, 'verify').mockImplementation(() => { throw new Error('boom'); });
      const ok = await signer.verify(data, sig, p256PubMb(pk));
      expect(ok).toBe(false);
      spy.mockRestore();
    });
  });

  describe('Ed25519Signer', () => {
    test('invalid multibase prefix throws on sign and verify', async () => {
      const signer = new Ed25519Signer();
      await expect(signer.sign(data, 'xabc')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers.');
      await expect(signer.verify(data, Buffer.alloc(64), 'xabc')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers.');
    });

    test('wrong key type throws on sign and verify', async () => {
      const signer = new Ed25519Signer();
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk);
      await expect(signer.sign(data, secpPrivMb(sk))).rejects.toThrow('Invalid key type for Ed25519');
      await expect(signer.verify(data, Buffer.alloc(64), secpPubMb(pk))).rejects.toThrow('Invalid key type for Ed25519');
    });

    test('sign and verify success; verify returns false with bad signature', async () => {
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKey(sk);
      const signer = new Ed25519Signer();
      const sig = await signer.sign(data, edPrivMb(sk));
      const ok = await signer.verify(data, sig, edPubMb(pk));
      expect(ok).toBe(true);

      const bad = Buffer.from(sig);
      bad[0] ^= 0xff;
      const okBad = await signer.verify(data, bad, edPubMb(pk));
      expect(okBad).toBe(false);
    });

    test('verify exception path returns false', async () => {
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKey(sk);
      const signer = new Ed25519Signer();
      const sig = await signer.sign(data, edPrivMb(sk));
      const spy = spyOn(ed25519, 'verifyAsync').mockImplementation(async () => { throw new Error('boom'); });
      const ok = await signer.verify(data, sig, edPubMb(pk));
      expect(ok).toBe(false);
      spy.mockRestore();
    });
  });

  describe('Bls12381G2Signer', () => {
    test('invalid multibase prefix throws on sign and verify', async () => {
      const signer = new Bls12381G2Signer();
      await expect(signer.sign(data, 'xabc')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers.');
      await expect(signer.verify(data, Buffer.alloc(96), 'xabc')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers.');
    });

    test('wrong key type throws on sign and verify', async () => {
      const signer = new Bls12381G2Signer();
      const edPriv = ed25519.utils.randomPrivateKey();
      const edPub = await ed25519.getPublicKey(edPriv);
      await expect(signer.sign(data, edPrivMb(edPriv))).rejects.toThrow('Invalid key type for Bls12381G2');
      await expect(signer.verify(data, Buffer.alloc(96), edPubMb(edPub))).rejects.toThrow('Invalid key type for Bls12381G2');
    });

    test('sign and verify success; verify returns false with bad signature', async () => {
      const sk = bls.utils.randomPrivateKey();
      const pk = await bls.getPublicKey(sk);
      const signer = new Bls12381G2Signer();
      const sig = await signer.sign(data, blsPrivMb(sk));
      const ok = await signer.verify(data, sig, blsPubMb(pk));
      expect(ok).toBe(true);

      const bad = Buffer.from(sig);
      bad[0] ^= 0xff;
      const okBad = await signer.verify(data, bad, blsPubMb(pk));
      expect(okBad).toBe(false);
    });

    test('verify exception path returns false', async () => {
      const sk = bls.utils.randomPrivateKey();
      const pk = await bls.getPublicKey(sk);
      const signer = new Bls12381G2Signer();
      const sig = await signer.sign(data, blsPrivMb(sk));
      spyOn(bls, 'verify').mockImplementation((_sig: any, _msg: any, _pk: any) => { throw new Error('boom'); });
      const ok = await signer.verify(data, sig, blsPubMb(pk));
      expect(ok).toBe(false);
    });
  });
});

/** Inlined from Signer.branch-extra.part.ts */

describe('ES256Signer extra branch coverage', () => {
  test('verify catch path when p256.verify throws', async () => {
    const signer = new ES256Signer();
    const sk = p256.utils.randomPrivateKey();
    const pk = p256.getPublicKey(sk);
    const sig = await signer.sign(Buffer.from('x'), p256PrivMb(sk));
    const spy = spyOn(p256, 'verify').mockImplementation(() => { throw new Error('boom'); });
    const ok = await signer.verify(Buffer.from('x'), sig, p256PubMb(pk));
    expect(ok).toBe(false);
    spy.mockRestore();
  });
});




/** Inlined from Signer.env.false-branch.part.ts */
describe('Signer module utils verification', () => {
  test('verifies secp256k1 utils.hmacSha256Sync exists and is callable', () => {
    // After module initialization, the utility function should exist
    const sAny = secp256k1 as any;
    expect(sAny.utils).toBeDefined();
    expect(typeof sAny.utils.hmacSha256Sync).toBe('function');
    // Verify it's callable without error
    const result = sAny.utils.hmacSha256Sync(new Uint8Array(32), new Uint8Array(10));
    expect(result).toBeInstanceOf(Uint8Array);
  });

  test('verifies ed25519 utils.sha512Sync exists and is callable', () => {
    // After module initialization, the utility function should exist
    const eAny = ed25519 as any;
    expect(eAny.utils).toBeDefined();
    expect(typeof eAny.utils.sha512Sync).toBe('function');
    // Verify it's callable without error
    const result = eAny.utils.sha512Sync(new Uint8Array(10));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(64); // SHA-512 produces 64 bytes
  });
});




/** Inlined from Signer.extra-branch-secp.part.ts */

describe('ES256KSigner branch: sign returns direct Uint8Array', () => {
  test('covers instanceof Uint8Array path', async () => {
    const signer = new ES256KSigner();
    const sk = secp256k1.utils.randomPrivateKey();
    const bytes = new Uint8Array(64).fill(5);
    const spy = spyOn(secp256k1, 'signAsync').mockResolvedValue(bytes as any);
    const sig = await signer.sign(Buffer.from('x'), secpPrivMb(sk));
    expect(Buffer.isBuffer(sig)).toBe(true);
    expect(sig).toEqual(Buffer.from(bytes));
    spy.mockRestore();
  });
});

describe('Signer error handling with non-Error objects', () => {
  describe('ES256KSigner', () => {
    test('sign handles string error from decodePrivateKey', async () => {
      const signer = new ES256KSigner();
      const spy = spyOn(multikey, 'decodePrivateKey').mockImplementation(() => {
        throw 'string error';
      });
      await expect(signer.sign(Buffer.from('test'), 'zinvalid')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers. string error');
      spy.mockRestore();
    });

    test('verify handles number error from decodePublicKey', async () => {
      const signer = new ES256KSigner();
      const spy = spyOn(multikey, 'decodePublicKey').mockImplementation(() => {
        throw 42;
      });
      await expect(signer.verify(Buffer.from('test'), Buffer.alloc(64), 'zinvalid')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers. 42');
      spy.mockRestore();
    });

    test('sign handles null error from decodePrivateKey', async () => {
      const signer = new ES256KSigner();
      const spy = spyOn(multikey, 'decodePrivateKey').mockImplementation(() => {
        throw null;
      });
      await expect(signer.sign(Buffer.from('test'), 'zinvalid')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers. null');
      spy.mockRestore();
    });
  });

  describe('ES256Signer', () => {
    test('sign handles object error from decodePrivateKey', async () => {
      const signer = new ES256Signer();
      const spy = spyOn(multikey, 'decodePrivateKey').mockImplementation(() => {
        throw { code: 'CUSTOM_ERROR', details: 'something' };
      });
      await expect(signer.sign(Buffer.from('test'), 'zinvalid')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers. [object Object]');
      spy.mockRestore();
    });

    test('verify handles undefined error from decodePublicKey', async () => {
      const signer = new ES256Signer();
      const spy = spyOn(multikey, 'decodePublicKey').mockImplementation(() => {
        throw undefined;
      });
      await expect(signer.verify(Buffer.from('test'), Buffer.alloc(64), 'zinvalid')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers. undefined');
      spy.mockRestore();
    });
  });

  describe('Ed25519Signer', () => {
    test('sign handles string error from decodePrivateKey', async () => {
      const signer = new Ed25519Signer();
      const spy = spyOn(multikey, 'decodePrivateKey').mockImplementation(() => {
        throw 'decode failed';
      });
      await expect(signer.sign(Buffer.from('test'), 'zinvalid')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers. decode failed');
      spy.mockRestore();
    });

    test('verify handles boolean error from decodePublicKey', async () => {
      const signer = new Ed25519Signer();
      const spy = spyOn(multikey, 'decodePublicKey').mockImplementation(() => {
        throw false;
      });
      await expect(signer.verify(Buffer.from('test'), Buffer.alloc(64), 'zinvalid')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers. false');
      spy.mockRestore();
    });
  });

  describe('Bls12381G2Signer', () => {
    test('sign handles array error from decodePrivateKey', async () => {
      const signer = new Bls12381G2Signer();
      const spy = spyOn(multikey, 'decodePrivateKey').mockImplementation(() => {
        throw ['error', 'array'];
      });
      await expect(signer.sign(Buffer.from('test'), 'zinvalid')).rejects.toThrow('Invalid multibase key format. Keys must use multicodec headers. error,array');
      spy.mockRestore();
    });

    test('verify handles symbol error from decodePublicKey', async () => {
      const signer = new Bls12381G2Signer();
      const spy = spyOn(multikey, 'decodePublicKey').mockImplementation(() => {
        throw Symbol('error');
      });
      await expect(signer.verify(Buffer.from('test'), Buffer.alloc(96), 'zinvalid')).rejects.toThrow(/Invalid multibase key format. Keys must use multicodec headers. Symbol\(error\)/);
      spy.mockRestore();
    });
  });
});
