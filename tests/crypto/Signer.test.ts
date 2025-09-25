import { ES256KSigner, Ed25519Signer, Bls12381G2Signer } from '../../src/crypto/Signer';
import { bls12_381 as bls } from '@noble/curves/bls12-381';

jest.mock('@noble/secp256k1', () => {
  const real = jest.requireActual('@noble/secp256k1');
  return {
    ...real,
    verify: jest.fn(() => true),
    signAsync: jest
      .fn()
      // 1) returns Uint8Array
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      // 2) returns object with toCompactRawBytes
      .mockResolvedValueOnce({ toCompactRawBytes: () => new Uint8Array([4, 5]) })
      // 3) returns object with toRawBytes
      .mockResolvedValueOnce({ toRawBytes: () => new Uint8Array([6]) })
      // 4) returns other object to hit default branch
      .mockResolvedValueOnce({ any: 1 })
  } as any;
});

jest.mock('@noble/ed25519', () => {
  const real = jest.requireActual('@noble/ed25519');
  return {
    ...real,
    signAsync: jest.fn(async (data: Uint8Array) => new Uint8Array(data)),
    verifyAsync: jest.fn(async () => true)
  } as any;
});

describe('Signer', () => {
  test('ES256KSigner invalid key errors', async () => {
    const s = new ES256KSigner();
    await expect(s.sign(Buffer.from('a'), 'xabc')).rejects.toThrow('Invalid multibase private key');
    await expect(s.verify(Buffer.from('a'), Buffer.from('b'), 'xabc')).rejects.toThrow('Invalid multibase public key');
  });

  test('Ed25519Signer invalid key errors', async () => {
    const s = new Ed25519Signer();
    await expect(s.sign(Buffer.from('a'), 'xabc')).rejects.toThrow('Invalid multibase private key');
    await expect(s.verify(Buffer.from('a'), Buffer.from('b'), 'xabc')).rejects.toThrow('Invalid multibase public key');
  });

  test('ES256KSigner verify returns boolean', async () => {
    const s = new ES256KSigner();
    const res = await s.verify(Buffer.from('a'), Buffer.from(''), 'z');
    expect(typeof res).toBe('boolean');
  });

  test('Ed25519Signer verify returns boolean', async () => {
    const s = new Ed25519Signer();
    const res = await s.verify(Buffer.from('a'), Buffer.from(''), 'z');
    expect(typeof res).toBe('boolean');
  });

  test('ES256KSigner sign handles return shapes', async () => {
    const s = new ES256KSigner();
    const key = 'z' + Buffer.from('k').toString('base64url');
    const b1 = await s.sign(Buffer.from('a'), key);
    expect(b1).toBeInstanceOf(Buffer);
    const b2 = await s.sign(Buffer.from('a'), key);
    expect(b2).toBeInstanceOf(Buffer);
    const b3 = await s.sign(Buffer.from('a'), key);
    expect(b3).toBeInstanceOf(Buffer);
    const b4 = await s.sign(Buffer.from('a'), key);
    expect(b4).toBeInstanceOf(Buffer);
  });

  test('ES256KSigner verify success path', async () => {
    const s = new ES256KSigner();
    const pub = 'z' + Buffer.from('p').toString('base64url');
    await expect(s.verify(Buffer.from('a'), Buffer.from('sig'), pub)).resolves.toBe(true);
  });

  test('Ed25519Signer sign/verify success paths', async () => {
    const s = new Ed25519Signer();
    const key = 'z' + Buffer.from('k').toString('base64url');
    const sig = await s.sign(Buffer.from('a'), key);
    expect(sig).toBeInstanceOf(Buffer);
    const pub = 'z' + Buffer.from('p').toString('base64url');
    await expect(s.verify(Buffer.from('a'), Buffer.from('sig'), pub)).resolves.toBe(true);
  });

  test('Bls12381G2Signer invalid key errors', async () => {
    const s = new Bls12381G2Signer();
    await expect(s.sign(Buffer.from('a'), 'xabc')).rejects.toThrow('Invalid multibase private key');
    await expect(s.verify(Buffer.from('a'), Buffer.from('b'), 'xabc')).rejects.toThrow('Invalid multibase public key');
  });

  test('Bls12381G2Signer sign/verify success and failure paths', async () => {
    const s = new Bls12381G2Signer();
    const sk = bls.utils.randomPrivateKey();
    const pk = bls.getPublicKey(sk);
    const skMb = 'z' + Buffer.from(sk).toString('base64url');
    const pkMb = 'z' + Buffer.from(pk).toString('base64url');

    const data = Buffer.from('hello');
    const sig = await s.sign(data, skMb);
    await expect(s.verify(data, sig, pkMb)).resolves.toBe(true);

    const other = Buffer.from('world');
    await expect(s.verify(other, sig, pkMb)).resolves.toBe(false);
  });

  test('ES256KSigner verify catch path returns false', async () => {
    const real = jest.requireActual('@noble/secp256k1');
    jest.resetModules();
    jest.doMock('@noble/secp256k1', () => ({
      ...real,
      verify: () => { throw new Error('boom'); }
    }));
    const { ES256KSigner } = await import('../../src/crypto/Signer');
    const s = new ES256KSigner();
    const pub = 'z' + Buffer.from('p').toString('base64url');
    await expect(s.verify(Buffer.from('a'), Buffer.from('sig'), pub)).resolves.toBe(false);
    jest.dontMock('@noble/secp256k1');
  });

  test('Ed25519Signer verify catch path returns false', async () => {
    const real = jest.requireActual('@noble/ed25519');
    jest.resetModules();
    jest.doMock('@noble/ed25519', () => ({
      ...real,
      verifyAsync: async () => { throw new Error('boom'); }
    }));
    const { Ed25519Signer } = await import('../../src/crypto/Signer');
    const s = new Ed25519Signer();
    const pub = 'z' + Buffer.from('p').toString('base64url');
    await expect(s.verify(Buffer.from('a'), Buffer.from('sig'), pub)).resolves.toBe(false);
    jest.dontMock('@noble/ed25519');
  });

  test('ES256Signer throws not implemented on sign/verify', async () => {
    // Import lazily to avoid affecting other tests
    const { ES256Signer } = await import('../../src/crypto/Signer');
    const s = new ES256Signer();
    await expect(s.sign(Buffer.from('a'), 'z' + Buffer.from('k').toString('base64url'))).rejects.toThrow('Not implemented');
    await expect(s.verify(Buffer.from('a'), Buffer.from('sig'), 'z' + Buffer.from('p').toString('base64url'))).rejects.toThrow('Not implemented');
  });

  test('Bls12381G2Signer verify returns false on internal error (catch path)', async () => {
    const s = new Bls12381G2Signer();
    const sk = bls.utils.randomPrivateKey();
    const pk = bls.getPublicKey(sk);
    const skMb = 'z' + Buffer.from(sk).toString('base64url');
    const pkMb = 'z' + Buffer.from(pk).toString('base64url');
    const data = Buffer.from('hello');
    const sig = await s.sign(data, skMb);
    const spy = jest.spyOn(bls, 'verify').mockImplementation(() => { throw new Error('boom'); });
    await expect(s.verify(data, sig, pkMb)).resolves.toBe(false);
    spy.mockRestore();
  });
});


