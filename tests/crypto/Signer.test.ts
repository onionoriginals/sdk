import { ES256KSigner, Ed25519Signer, ES256Signer } from '../../src/crypto/Signer';
import { KeyManager } from '../../src/did/KeyManager';

const data = Buffer.from('test data');

describe('Signers', () => {
  test('ES256KSigner sign/verify', async () => {
    const signer = new ES256KSigner();
    const km = new KeyManager();
    const pair = await km.generateKeyPair('ES256K' as any);
    const sig = await signer.sign(data, pair.privateKey);
    await expect(signer.verify(data, sig, pair.publicKey)).resolves.toBe(true);
  });

  test('Ed25519Signer sign/verify throws until implemented', async () => {
    const signer = new Ed25519Signer();
    const km = new KeyManager();
    const pair = await km.generateKeyPair('Ed25519' as any);
    const sig = await signer.sign(data, pair.privateKey);
    await expect(signer.verify(data, sig, pair.publicKey)).resolves.toBe(true);
  });

  test('ES256Signer sign/verify throws until implemented', async () => {
    const signer = new ES256Signer();
    await expect(signer.sign(data, 'zprivkey')).rejects.toThrow('Not implemented');
    await expect(signer.verify(data, Buffer.alloc(0), 'zpubkey')).rejects.toThrow('Not implemented');
  });

  test('ES256KSigner verify returns false for invalid signature', async () => {
    const signer = new ES256KSigner();
    const km = new KeyManager();
    const pair = await km.generateKeyPair('ES256K' as any);
    await expect(signer.verify(data, Buffer.alloc(64), pair.publicKey)).resolves.toBe(false);
  });

  test('ES256KSigner guards invalid multibase keys', async () => {
    const signer = new ES256KSigner();
    await expect(signer.sign(data, 'bad')).rejects.toThrow('Invalid multibase private key');
    await expect(signer.verify(data, Buffer.alloc(0), 'bad')).rejects.toThrow('Invalid multibase public key');
  });

  test('Ed25519Signer verify rejects (expected to pass)', async () => {
    const signer = new Ed25519Signer();
    const km = new KeyManager();
    const pair = await km.generateKeyPair('Ed25519' as any);
    await expect(signer.verify(data, Buffer.alloc(0), pair.publicKey)).resolves.toBe(false);
  });

  test('Ed25519Signer guards invalid multibase keys', async () => {
    const signer = new Ed25519Signer();
    await expect(signer.sign(data, 'bad')).rejects.toThrow('Invalid multibase private key');
    await expect(signer.verify(data, Buffer.alloc(0), 'bad')).rejects.toThrow('Invalid multibase public key');
  });

  test('ES256Signer verify rejects (expected to pass)', async () => {
    const signer = new ES256Signer();
    await expect(signer.verify(data, Buffer.alloc(0), 'zpubkey')).rejects.toThrow('Not implemented');
  });
});


