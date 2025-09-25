jest.mock('@noble/secp256k1', () => {
  return {
    verify: jest.fn(() => true),
    signAsync: jest
      .fn()
      // 1) returns Uint8Array
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      // 2) returns object with toCompactRawBytes
      .mockResolvedValueOnce({ toCompactRawBytes: () => new Uint8Array([4, 5]) })
      // 3) returns object with toRawBytes
      .mockResolvedValueOnce({ toRawBytes: () => new Uint8Array([6]) })
  } as any;
});

jest.mock('@noble/ed25519', () => {
  return {
    signAsync: jest.fn(async (data: Uint8Array) => new Uint8Array(data)),
    verifyAsync: jest.fn(async () => true)
  } as any;
});

import { ES256KSigner, Ed25519Signer } from '../../src/crypto/Signer';

describe('Signer success branches', () => {
  test('ES256KSigner sign handles all return shapes', async () => {
    const s = new ES256KSigner();
    const key = 'z' + Buffer.from('k').toString('base64url');
    const b1 = await s.sign(Buffer.from('a'), key);
    expect(b1).toBeInstanceOf(Buffer);
    const b2 = await s.sign(Buffer.from('a'), key);
    expect(b2).toBeInstanceOf(Buffer);
    const b3 = await s.sign(Buffer.from('a'), key);
    expect(b3).toBeInstanceOf(Buffer);
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
});

