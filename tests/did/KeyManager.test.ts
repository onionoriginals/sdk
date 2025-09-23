import { KeyManager } from '../../src/did/KeyManager';
import { DIDDocument, KeyPair, KeyType } from '../../src/types';

describe('KeyManager', () => {
  const km = new KeyManager();

  test('generateKeyPair returns multibase encoded ES256K keys', async () => {
    const pair: KeyPair = await km.generateKeyPair('ES256K' as KeyType);
    expect(pair.privateKey.startsWith('z')).toBe(true);
    expect(pair.publicKey.startsWith('z')).toBe(true);
  });

  test('generateKeyPair returns multibase encoded Ed25519 keys', async () => {
    const pair: KeyPair = await km.generateKeyPair('Ed25519' as KeyType);
    expect(pair.privateKey.startsWith('z')).toBe(true);
    expect(pair.publicKey.startsWith('z')).toBe(true);
  });

  test('encode/decode multibase roundtrip', () => {
    const pub = Buffer.from('hello');
    const encoded = km.encodePublicKeyMultibase(pub, 'ES256K' as KeyType);
    const decoded = km.decodePublicKeyMultibase(encoded);
    expect(decoded.key.equals(pub)).toBe(true);
  });

  test('rotateKeys updates DID document keys', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    const pair: KeyPair = await km.generateKeyPair('ES256K' as KeyType);
    const rotated = await km.rotateKeys(didDoc, pair);
    expect(rotated.verificationMethod?.[0].publicKeyMultibase).toBe(pair.publicKey);
  });

  test('recoverFromCompromise returns doc', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    await expect(km.recoverFromCompromise(didDoc)).resolves.toBeDefined();
  });

  test('decodePublicKeyMultibase validates input', () => {
    expect(() => km.decodePublicKeyMultibase('bad')).toThrow('Invalid multibase string');
  });

  test('generateKeyPair throws on unsupported type', async () => {
    await expect(km.generateKeyPair('ES256' as KeyType)).rejects.toThrow('Only ES256K and Ed25519 supported at this time');
  });
});


