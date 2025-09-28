import { KeyManager } from '../../src/did/KeyManager';
import { DIDDocument, KeyPair, KeyType } from '../../src/types';

describe('KeyManager', () => {
  const km = new KeyManager();

  test('generateKeyPair ES256K works', async () => {
    const kp = await km.generateKeyPair('ES256K');
    expect(kp.privateKey.startsWith('z')).toBe(true);
    expect(kp.publicKey.startsWith('z')).toBe(true);
  });

  test('generateKeyPair Ed25519 works', async () => {
    const kp = await km.generateKeyPair('Ed25519');
    expect(kp.privateKey.startsWith('z')).toBe(true);
    expect(kp.publicKey.startsWith('z')).toBe(true);
  });

  test('decodePublicKeyMultibase invalid input throws', () => {
    expect(() => km.decodePublicKeyMultibase('abc')).toThrow('Invalid multibase string');
  });

  test('encode/decode multibase roundtrip', () => {
    const pub = Buffer.from('hello');
    const encoded = km.encodePublicKeyMultibase(pub, 'ES256K' as KeyType);
    const decoded = km.decodePublicKeyMultibase(encoded);
    expect(decoded.key.equals(pub)).toBe(true);
    expect(decoded.type).toBe('ES256K');
  });

  test('decodePublicKeyMultibase handles Ed25519 multikey values', () => {
    const pub = Buffer.from([0, 255, 1, 2, 3, 4, 5]);
    const encoded = km.encodePublicKeyMultibase(pub, 'Ed25519' as KeyType);
    const decoded = km.decodePublicKeyMultibase(encoded);
    expect(decoded.key.equals(pub)).toBe(true);
    expect(decoded.type).toBe('Ed25519');
  });

  test('rotateKeys updates DID document keys', async () => {
    const didDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:xyz' };
    const pair: KeyPair = await km.generateKeyPair('ES256K' as KeyType);
    const rotated = await km.rotateKeys(didDoc, pair);
    expect(rotated.verificationMethod?.[0].publicKeyMultibase).toBe(pair.publicKey);
    // Verify that multikey context is added when using Multikey verification method
    expect(rotated['@context']).toContain('https://w3id.org/security/multikey/v1');
    expect(rotated.verificationMethod?.[0].type).toBe('Multikey');
  });

  test('rotateKeys does not duplicate multikey context if already present', async () => {
    const didDoc: DIDDocument = { 
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], 
      id: 'did:peer:abc' 
    };
    const pair: KeyPair = await km.generateKeyPair('ES256K' as KeyType);
    const rotated = await km.rotateKeys(didDoc, pair);
    
    // Count occurrences of multikey context
    const contextCount = rotated['@context'].filter(c => c === 'https://w3id.org/security/multikey/v1').length;
    expect(contextCount).toBe(1);
    expect(rotated['@context']).toContain('https://w3id.org/security/multikey/v1');
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

  test('constructor initializes utils helpers without throwing', () => {
    const instance = new KeyManager();
    expect(instance).toBeInstanceOf(KeyManager);
    // call utils to cover helper branches
    const secp = require('@noble/secp256k1');
    const ed = require('@noble/ed25519');
    if (secp.utils && typeof secp.utils.hmacSha256Sync === 'function') {
      secp.utils.hmacSha256Sync(new Uint8Array([1]), new Uint8Array([2]));
    }
    if (ed.utils && typeof ed.utils.sha512Sync === 'function') {
      ed.utils.sha512Sync(new Uint8Array([3]));
    }
  });

  test('constructor covers utils undefined branch (creates helpers when missing)', () => {
    const secp = require('@noble/secp256k1');
    const ed = require('@noble/ed25519');
    const origSecpUtils = secp.utils;
    const origEdUtils = ed.utils;
    try {
      // Remove utils to trigger RHS of `|| {}`
      secp.utils = undefined;
      ed.utils = undefined;
      const km2 = new KeyManager();
      expect(km2).toBeInstanceOf(KeyManager);
      expect(secp.utils && typeof secp.utils.hmacSha256Sync).toBe('function');
      expect(ed.utils && typeof ed.utils.sha512Sync).toBe('function');
    } finally {
      // Restore originals
      secp.utils = origSecpUtils;
      ed.utils = origEdUtils;
    }
  });
});


