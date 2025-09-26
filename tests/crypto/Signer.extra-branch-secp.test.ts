import { ES256KSigner } from '../../src/crypto/Signer';
import * as secp256k1 from '@noble/secp256k1';

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

