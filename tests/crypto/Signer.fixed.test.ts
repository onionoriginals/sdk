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

