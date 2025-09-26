import { ES256Signer } from '../../src/crypto/Signer';
import { p256 } from '@noble/curves/p256';

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

