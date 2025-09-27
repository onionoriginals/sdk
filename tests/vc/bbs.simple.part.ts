import { BbsSimple } from '../../src';
import { bls12_381 as bls } from '@noble/curves/bls12-381';

describe('BbsSimple e2e', () => {
  test('sign/verify not implemented with header', async () => {
    const sk = bls.utils.randomPrivateKey();
    const pk = bls.getPublicKey(sk);
    const keypair = { privateKey: sk, publicKey: pk };
    const header = new Uint8Array([1, 2, 3]);
    const messages = [
      new TextEncoder().encode('msg1'),
      new TextEncoder().encode('msg2'),
      new TextEncoder().encode('msg3')
    ];

    await expect(BbsSimple.sign(messages, keypair, header)).rejects.toThrow(/not implemented/i);
    await expect(BbsSimple.verify(messages, new Uint8Array([0]), pk, header)).rejects.toThrow(/not implemented/i);
  });

  test('sign/verify not implemented with default header', async () => {
    const sk = bls.utils.randomPrivateKey();
    const pk = bls.getPublicKey(sk);
    const keypair = { privateKey: sk, publicKey: pk };
    const messages = [
      new TextEncoder().encode('a'),
      new TextEncoder().encode('b')
    ];
    await expect(BbsSimple.sign(messages, keypair)).rejects.toThrow(/not implemented/i);
    await expect(BbsSimple.verify(messages, new Uint8Array([1, 2]), pk)).rejects.toThrow(/not implemented/i);
  });
});

