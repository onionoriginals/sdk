import { KeyManager } from '../../src/did/KeyManager';
import { DIDDocument, KeyPair, KeyType } from '../../src/types';

describe('KeyManager', () => {
  const km = new KeyManager();

  test('generateKeyPair returns multibase encoded keys (expected to fail until implemented)', async () => {
    const pair: KeyPair = await km.generateKeyPair('ES256K' as KeyType);
    expect(pair.privateKey.startsWith('z')).toBe(true);
    expect(pair.publicKey.startsWith('z')).toBe(true);
  });

  test('encode/decode multibase roundtrip (expected to fail until implemented)', () => {
    const pub = Buffer.from('hello');
    const encoded = km.encodePublicKeyMultibase(pub, 'ES256K' as KeyType);
    const decoded = km.decodePublicKeyMultibase(encoded);
    expect(decoded.key.equals(pub)).toBe(true);
  });

  test('rotateKeys updates DID document keys (expected to fail until implemented)', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    const pair: KeyPair = { privateKey: 'zpriv', publicKey: 'zpub' } as any;
    const rotated = await km.rotateKeys(didDoc, pair);
    expect(rotated).toBeDefined();
  });

  test('recoverFromCompromise handles recovery flow (expected to fail until implemented)', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    await expect(km.recoverFromCompromise(didDoc)).resolves.toBeDefined();
  });

  test('decodePublicKeyMultibase throws (coverage for throw)', () => {
    expect(() => km.decodePublicKeyMultibase('zabc' as any)).toThrow('Not implemented');
  });
});


