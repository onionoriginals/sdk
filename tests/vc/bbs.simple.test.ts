import { BbsSimple } from '../../src';
import { bls12_381 as bls } from '@noble/curves/bls12-381';

describe('BbsSimple e2e', () => {
  test('sign/verify baseline with header', async () => {
    const sk = bls.utils.randomPrivateKey();
    const pk = bls.getPublicKey(sk);
    const keypair = { privateKey: sk, publicKey: pk };
    const header = new Uint8Array([1, 2, 3]);
    const messages = [
      new TextEncoder().encode('msg1'),
      new TextEncoder().encode('msg2'),
      new TextEncoder().encode('msg3')
    ];

    const sig = await BbsSimple.sign(messages, keypair, header);
    await expect(BbsSimple.verify(messages, sig, pk, header)).resolves.toBe(true);
    const messages2 = [
      new TextEncoder().encode('msg1'),
      new TextEncoder().encode('DIFF'),
      new TextEncoder().encode('msg3')
    ];
    await expect(BbsSimple.verify(messages2, sig, pk, header)).resolves.toBe(false);
  });
});

