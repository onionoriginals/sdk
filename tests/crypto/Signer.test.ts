import { ES256KSigner, ES256Signer, Ed25519Signer, Bls12381G2Signer } from '../../src/crypto/Signer';
import * as secp256k1 from '@noble/secp256k1';
import { p256 } from '@noble/curves/p256';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import * as ed25519 from '@noble/ed25519';

const mb = (bytes: Uint8Array) => 'z' + Buffer.from(bytes).toString('base64url');

describe('Signer classes', () => {
  const data = Buffer.from('hello world');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ES256KSigner', () => {
    test('invalid multibase prefix throws on sign and verify', async () => {
      const signer = new ES256KSigner();
      await expect(signer.sign(data, 'xabc')).rejects.toThrow('Invalid multibase private key');
      await expect(signer.verify(data, Buffer.alloc(64), 'xabc')).rejects.toThrow('Invalid multibase public key');
    });

    test('sign returns bytes path (Uint8Array direct)', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk);
      const signer = new ES256KSigner();
      const sig = await signer.sign(data, mb(sk));
      expect(Buffer.isBuffer(sig)).toBe(true);
      const ok = await signer.verify(data, sig, mb(pk));
      expect(ok).toBe(true);
    });

    test('verify returns false for bad signature', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk);
      const signer = new ES256KSigner();
      const sig = await signer.sign(data, mb(sk));
      const bad = Buffer.from(sig);
      bad[0] ^= 0xff;
      const ok = await signer.verify(data, bad, mb(pk));
      expect(ok).toBe(false);
    });

    test('sign handles object with toCompactRawBytes()', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const signer = new ES256KSigner();
      const bytes = new Uint8Array(64).fill(7);
      jest.spyOn(secp256k1, 'signAsync').mockResolvedValue({
        toCompactRawBytes: () => bytes
      } as any);
      const sig = await signer.sign(data, mb(sk));
      expect(sig.equals(Buffer.from(bytes))).toBe(true);
    });

    test('sign handles object with toRawBytes()', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const signer = new ES256KSigner();
      const bytes = new Uint8Array(64).fill(9);
      jest.spyOn(secp256k1, 'signAsync').mockResolvedValue({
        toRawBytes: () => bytes
      } as any);
      const sig = await signer.sign(data, mb(sk));
      expect(sig.equals(Buffer.from(bytes))).toBe(true);
    });

    test('sign handles fallback via new Uint8Array(sigAny)', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const signer = new ES256KSigner();
      const arr = Array.from({ length: 64 }, (_, i) => (i + 1) & 0xff);
      jest.spyOn(secp256k1, 'signAsync').mockResolvedValue(arr as any);
      const sig = await signer.sign(data, mb(sk));
      expect(sig).toHaveLength(64);
      expect(sig[0]).toBe(1);
      expect(sig[63]).toBe(64);
    });

    test('verify exception path returns false', async () => {
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk);
      const signer = new ES256KSigner();
      const sig = await signer.sign(data, mb(sk));
      jest.spyOn(secp256k1, 'verify').mockImplementation(() => { throw new Error('boom'); });
      const ok = await signer.verify(data, sig, mb(pk));
      expect(ok).toBe(false);
    });
  });

  describe('ES256Signer', () => {
    test('invalid multibase prefix throws on sign and verify', async () => {
      const signer = new ES256Signer();
      await expect(signer.sign(data, 'xabc')).rejects.toThrow('Invalid multibase private key');
      await expect(signer.verify(data, Buffer.alloc(64), 'xabc')).rejects.toThrow('Invalid multibase public key');
    });

    test('sign returns bytes path (Uint8Array direct)', async () => {
      const sk = p256.utils.randomPrivateKey();
      const pk = p256.getPublicKey(sk);
      const signer = new ES256Signer();
      const sig = await signer.sign(data, mb(sk));
      expect(Buffer.isBuffer(sig)).toBe(true);
      const ok = await signer.verify(data, sig, mb(pk));
      expect(ok).toBe(true);
    });

    test('verify returns false for bad signature', async () => {
      const sk = p256.utils.randomPrivateKey();
      const pk = p256.getPublicKey(sk);
      const signer = new ES256Signer();
      const sig = await signer.sign(data, mb(sk));
      const bad = Buffer.from(sig);
      bad[0] ^= 0xff;
      const ok = await signer.verify(data, bad, mb(pk));
      expect(ok).toBe(false);
    });

    test('sign handles object with toCompactRawBytes()', async () => {
      const sk = p256.utils.randomPrivateKey();
      const signer = new ES256Signer();
      const bytes = new Uint8Array(64).fill(11);
      jest.spyOn(p256, 'sign').mockReturnValue({
        toCompactRawBytes: () => bytes
      } as any);
      const sig = await signer.sign(data, mb(sk));
      expect(sig.equals(Buffer.from(bytes))).toBe(true);
    });

    test('sign handles object with toRawBytes()', async () => {
      const sk = p256.utils.randomPrivateKey();
      const signer = new ES256Signer();
      const bytes = new Uint8Array(64).fill(13);
      jest.spyOn(p256, 'sign').mockReturnValue({
        toRawBytes: () => bytes
      } as any);
      const sig = await signer.sign(data, mb(sk));
      expect(sig.equals(Buffer.from(bytes))).toBe(true);
    });

    test('sign handles direct Uint8Array return', async () => {
      const sk = p256.utils.randomPrivateKey();
      const signer = new ES256Signer();
      const bytes = new Uint8Array(64).fill(21);
      jest.spyOn(p256, 'sign').mockReturnValue(bytes as any);
      const sig = await signer.sign(data, mb(sk));
      expect(sig.equals(Buffer.from(bytes))).toBe(true);
    });

    test('sign handles fallback via new Uint8Array(sigAny)', async () => {
      const sk = p256.utils.randomPrivateKey();
      const signer = new ES256Signer();
      const arr = Array.from({ length: 64 }, (_, i) => (i + 1) & 0xff);
      jest.spyOn(p256, 'sign').mockReturnValue(arr as any);
      const sig = await signer.sign(data, mb(sk));
      expect(sig).toHaveLength(64);
      expect(sig[0]).toBe(1);
      expect(sig[63]).toBe(64);
    });

    test('verify exception path returns false', async () => {
      const sk = p256.utils.randomPrivateKey();
      const pk = p256.getPublicKey(sk);
      const signer = new ES256Signer();
      const sig = await signer.sign(data, mb(sk));
      jest.spyOn(p256, 'verify').mockImplementation(() => { throw new Error('boom'); });
      const ok = await signer.verify(data, sig, mb(pk));
      expect(ok).toBe(false);
    });
  });

  describe('Ed25519Signer', () => {
    test('invalid multibase prefix throws on sign and verify', async () => {
      const signer = new Ed25519Signer();
      await expect(signer.sign(data, 'xabc')).rejects.toThrow('Invalid multibase private key');
      await expect(signer.verify(data, Buffer.alloc(64), 'xabc')).rejects.toThrow('Invalid multibase public key');
    });

    test('sign and verify success; verify returns false with bad signature', async () => {
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKey(sk);
      const signer = new Ed25519Signer();
      const sig = await signer.sign(data, mb(sk));
      const ok = await signer.verify(data, sig, mb(pk));
      expect(ok).toBe(true);

      const bad = Buffer.from(sig);
      bad[0] ^= 0xff;
      const okBad = await signer.verify(data, bad, mb(pk));
      expect(okBad).toBe(false);
    });

    test('verify exception path returns false', async () => {
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKey(sk);
      const signer = new Ed25519Signer();
      const sig = await signer.sign(data, mb(sk));
      jest.spyOn(ed25519, 'verifyAsync').mockImplementation(async () => { throw new Error('boom'); });
      const ok = await signer.verify(data, sig, mb(pk));
      expect(ok).toBe(false);
    });
  });

  describe('Bls12381G2Signer', () => {
    test('invalid multibase prefix throws on sign and verify', async () => {
      const signer = new Bls12381G2Signer();
      await expect(signer.sign(data, 'xabc')).rejects.toThrow('Invalid multibase private key');
      await expect(signer.verify(data, Buffer.alloc(96), 'xabc')).rejects.toThrow('Invalid multibase public key');
    });

    test('sign and verify success; verify returns false with bad signature', async () => {
      const sk = bls.utils.randomPrivateKey();
      const pk = await bls.getPublicKey(sk);
      const signer = new Bls12381G2Signer();
      const sig = await signer.sign(data, mb(sk));
      const ok = await signer.verify(data, sig, mb(pk));
      expect(ok).toBe(true);

      const bad = Buffer.from(sig);
      bad[0] ^= 0xff;
      const okBad = await signer.verify(data, bad, mb(pk));
      expect(okBad).toBe(false);
    });

    test('verify exception path returns false', async () => {
      const sk = bls.utils.randomPrivateKey();
      const pk = await bls.getPublicKey(sk);
      const signer = new Bls12381G2Signer();
      const sig = await signer.sign(data, mb(sk));
      jest.spyOn(bls, 'verify').mockImplementation((_sig: any, _msg: any, _pk: any) => { throw new Error('boom'); });
      const ok = await signer.verify(data, sig, mb(pk));
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
    const sig = await signer.sign(Buffer.from('x'), 'z' + Buffer.from(sk).toString('base64url'));
    const spy = jest.spyOn(p256, 'verify').mockImplementation(() => { throw new Error('boom'); });
    const ok = await signer.verify(Buffer.from('x'), sig, 'z' + Buffer.from(pk).toString('base64url'));
    expect(ok).toBe(false);
    spy.mockRestore();
  });
});




/** Inlined from Signer.env.false-branch.part.ts */
describe('Signer module env false branches (no injection when already present)', () => {
  test('does not inject when utils already provide functions', async () => {
    jest.resetModules();
    jest.doMock('@noble/secp256k1', () => {
      return { __esModule: true, utils: { hmacSha256Sync: jest.fn(() => new Uint8Array(32)) } };
    });
    jest.doMock('@noble/ed25519', () => {
      return { __esModule: true, utils: { sha512Sync: jest.fn(() => new Uint8Array(64)) } };
    });

    // Import inside isolated module context so the top-level checks run with our mocks
    await import('../../src/crypto/Signer');

    const secp = require('@noble/secp256k1');
    const ed = require('@noble/ed25519');
    expect(typeof secp.utils.hmacSha256Sync).toBe('function');
    expect(typeof ed.utils.sha512Sync).toBe('function');
  });
});




/** Inlined from Signer.env.part.ts */
describe('Signer module utils injection', () => {
  test('injects hmacSha256Sync when missing', async () => {
    jest.resetModules();
    const secp = require('@noble/secp256k1');
    const prev = secp.utils.hmacSha256Sync;
    // Remove function to trigger injection on module load
    delete secp.utils.hmacSha256Sync;
    const mod = await import('../../src/crypto/Signer');
    expect(typeof (require('@noble/secp256k1').utils.hmacSha256Sync)).toBe('function');
    // call the injected function to cover its body
    const key = new Uint8Array([1,2,3]);
    const out = require('@noble/secp256k1').utils.hmacSha256Sync(key, new Uint8Array([4,5]), new Uint8Array([6]));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
    // restore
    require('@noble/secp256k1').utils.hmacSha256Sync = prev;
  });

  test('injects ed25519 sha512Sync when missing', async () => {
    jest.resetModules();
    const e = require('@noble/ed25519');
    const prev = e.utils.sha512Sync;
    delete e.utils.sha512Sync;
    await import('../../src/crypto/Signer');
    expect(typeof (require('@noble/ed25519').utils.sha512Sync)).toBe('function');
    // call the injected function to cover its body
    const out = require('@noble/ed25519').utils.sha512Sync(new Uint8Array([1,2,3]));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(64);
    // restore
    require('@noble/ed25519').utils.sha512Sync = prev;
  });
});




/** Inlined from Signer.extra-branch-secp.part.ts */

describe('ES256KSigner branch: sign returns direct Uint8Array', () => {
  test('covers instanceof Uint8Array path', async () => {
    const signer = new ES256KSigner();
    const sk = secp256k1.utils.randomPrivateKey();
    const bytes = new Uint8Array(64).fill(5);
    const spy = jest.spyOn(secp256k1, 'signAsync').mockResolvedValue(bytes as any);
    const sig = await signer.sign(Buffer.from('x'), 'z' + Buffer.from(sk).toString('base64url'));
    expect(Buffer.isBuffer(sig)).toBe(true);
    expect(sig.equals(Buffer.from(bytes))).toBe(true);
    spy.mockRestore();
  });
});
