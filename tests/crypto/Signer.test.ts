import { ES256KSigner, Ed25519Signer, ES256Signer } from '../../src/crypto/Signer';

const data = Buffer.from('test data');

describe('Signers', () => {
  test('ES256KSigner sign/verify (expected to fail until implemented)', async () => {
    const signer = new ES256KSigner();
    const sig = await signer.sign(data, 'zprivkey');
    await expect(signer.verify(data, sig, 'zpubkey')).resolves.toBe(true);
  });

  test('Ed25519Signer sign/verify (expected to fail until implemented)', async () => {
    const signer = new Ed25519Signer();
    const sig = await signer.sign(data, 'zprivkey');
    await expect(signer.verify(data, sig, 'zpubkey')).resolves.toBe(true);
  });

  test('ES256Signer sign/verify (expected to fail until implemented)', async () => {
    const signer = new ES256Signer();
    const sig = await signer.sign(data, 'zprivkey');
    await expect(signer.verify(data, sig, 'zpubkey')).resolves.toBe(true);
  });

  test('ES256KSigner verify rejects (expected to pass)', async () => {
    const signer = new ES256KSigner();
    await expect(signer.verify(data, Buffer.alloc(0), 'zpubkey')).rejects.toThrow('Not implemented');
  });

  test('Ed25519Signer verify rejects (expected to pass)', async () => {
    const signer = new Ed25519Signer();
    await expect(signer.verify(data, Buffer.alloc(0), 'zpubkey')).rejects.toThrow('Not implemented');
  });

  test('ES256Signer verify rejects (expected to pass)', async () => {
    const signer = new ES256Signer();
    await expect(signer.verify(data, Buffer.alloc(0), 'zpubkey')).rejects.toThrow('Not implemented');
  });
});


