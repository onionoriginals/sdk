import { ES256KSigner, Ed25519Signer } from '../../src/crypto/Signer';

describe('Signer additional branches', () => {
  test('ES256KSigner verify catch branch returns false', async () => {
    const s = new ES256KSigner();
    const res = await s.verify(Buffer.from('a'), Buffer.from(''), 'z');
    expect(res).toBe(false);
  });

  test('Ed25519Signer verify catch branch returns false', async () => {
    const s = new Ed25519Signer();
    const res = await s.verify(Buffer.from('a'), Buffer.from(''), 'z');
    expect(res).toBe(false);
  });
});

