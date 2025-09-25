import { expect, test, describe } from 'bun:test';
import * as ed25519 from '@stablelib/ed25519';
import * as secp from '@noble/secp256k1';
import { KeyType, Multikey } from '../../../lib/crypto/keypairs/Multikey';
import { bls12_381 as bls } from '@noble/curves/bls12-381';

describe('Multikey', () => {
  // Generate real Ed25519 key pair
  const ed25519KeyPair = ed25519.generateKeyPair();
  const ed25519PublicKey = ed25519KeyPair.publicKey;
  const ed25519PrivateKey = ed25519KeyPair.secretKey;

  // Generate real Secp256k1 key pair
  const secp256k1PrivateKey = secp.utils.randomPrivateKey();
  const secp256k1PublicKey = secp.getPublicKey(secp256k1PrivateKey);

  test('should create an Ed25519 Multikey', () => {
    const multikey = new Multikey(KeyType.Ed25519, 'did:example:123#key-1', 'did:example:123', ed25519PublicKey, ed25519PrivateKey);
    expect(multikey.type).toBe('Multikey');
    expect(multikey.publicKeyMultibase).toStartWith('z');
    expect(multikey.secretKeyMultibase).toStartWith('z');
  });

  test('should create a Secp256k1 Multikey', () => {
    const multikey = new Multikey(KeyType.Secp256k1, 'did:example:456#key-2', 'did:example:456', secp256k1PublicKey, secp256k1PrivateKey);
    expect(multikey.type).toBe('Multikey');
    expect(multikey.publicKeyMultibase).toStartWith('z');
    expect(multikey.secretKeyMultibase).toStartWith('z');
  });

  test('should decode Ed25519 public key', () => {
    const multikey = new Multikey(KeyType.Ed25519, 'did:example:123#key-1', 'did:example:123', ed25519PublicKey, ed25519PrivateKey);
    const decoded = Multikey.decodePublicKey(multikey.publicKeyMultibase);
    expect(decoded.keyType).toBe(KeyType.Ed25519);
    expect(decoded.publicKey).toEqual(ed25519PublicKey);
  });

  test('should decode Secp256k1 public key', () => {
    const multikey = new Multikey(KeyType.Secp256k1, 'did:example:456#key-2', 'did:example:456', secp256k1PublicKey, secp256k1PrivateKey);
    const decoded = Multikey.decodePublicKey(multikey.publicKeyMultibase);
    expect(decoded.keyType).toBe(KeyType.Secp256k1);
    expect(decoded.publicKey).toEqual(secp256k1PublicKey);
  });

  test('should decode Ed25519 private key', () => {
    const multikey = new Multikey(KeyType.Ed25519, 'did:example:123#key-1', 'did:example:123', ed25519PublicKey, ed25519PrivateKey);
    const decoded = Multikey.decodePrivateKey(multikey.secretKeyMultibase!);
    expect(decoded.keyType).toBe(KeyType.Ed25519);
    expect(decoded.privateKey).toEqual(ed25519PrivateKey);
  });

  test('should decode Secp256k1 private key', () => {
    const multikey = new Multikey(KeyType.Secp256k1, 'did:example:456#key-2', 'did:example:456', secp256k1PublicKey, secp256k1PrivateKey);
    const decoded = Multikey.decodePrivateKey(multikey.secretKeyMultibase!);
    expect(decoded.keyType).toBe(KeyType.Secp256k1);
    expect(decoded.privateKey).toEqual(secp256k1PrivateKey);
  });

  test('should generate correct JSON representation', () => {
    const multikey = new Multikey(KeyType.Ed25519, 'did:example:123#key-1', 'did:example:123', ed25519PublicKey, ed25519PrivateKey);
    const json = multikey.toJSON();
    expect(json['@context']).toEqual(['https://w3id.org/security/multikey/v1']);
    expect(json.id).toBe('did:example:123#key-1');
    expect(json.type).toBe('Multikey');
    expect(json.controller).toBe('did:example:123');
    expect(json.publicKeyMultibase).toBeDefined();
    expect(json.secretKeyMultibase).toBeDefined();
  });

  test('should sign and verify with Ed25519 key', async () => {
    const multikey = new Multikey(KeyType.Ed25519, 'did:example:123#key-1', 'did:example:123', ed25519PublicKey, ed25519PrivateKey);
    const data = new TextEncoder().encode('Hello, world!');
    const signature = await multikey.sign(data);
    const isValid = await multikey.verify(data, signature);
    expect(isValid).toBe(true);
  });

  test('should sign with Secp256k1 key and return Uint8Array', async () => {
    const multikey = new Multikey(KeyType.Secp256k1, 'did:example:456#key-2', 'did:example:456', secp256k1PublicKey, secp256k1PrivateKey);
    const data = new TextEncoder().encode('Hello, world!');
    const signature = await multikey.sign(data);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);
  });

  test('should sign and verify with Secp256k1 key', async () => {
    const multikey = new Multikey(KeyType.Secp256k1, 'did:example:456#key-2', 'did:example:456', secp256k1PublicKey, secp256k1PrivateKey);
    const data = new TextEncoder().encode('Hello, world!');
    const signature = await multikey.sign(data);
    const isValid = await multikey.verify(data, signature);
    expect(isValid).toBe(true);
  });

  test('should fail to verify with incorrect data', async () => {
    const multikey = new Multikey(KeyType.Ed25519, 'did:example:123#key-1', 'did:example:123', ed25519PublicKey, ed25519PrivateKey);
    const data = new TextEncoder().encode('Hello, world!');
    const signature = await multikey.sign(data);
    const incorrectData = new TextEncoder().encode('Hello, World!');
    const isValid = await multikey.verify(incorrectData, signature);
    expect(isValid).toBe(false);
  });

  test('should throw error when trying to sign without private key', async () => {
    const multikey = new Multikey(KeyType.Ed25519, 'did:example:789#key-3', 'did:example:789', ed25519PublicKey);
    const data = new TextEncoder().encode('Hello, world!');
    expect(multikey.sign(data)).rejects.toThrow('No private key available for signing');
  });

  test('should throw error for unsupported key type', () => {
    expect(() => {
      new Multikey('UnsupportedType' as KeyType, 'did:example:789#key-3', 'did:example:789', new Uint8Array(32));
    }).toThrow('Unsupported key type');
  });
});

describe('Multikey BLS12-381', () => {
  test('should generate BLS12-381 key pair', async () => {
    const multikey = await Multikey.generate(KeyType.Bls12381G2);
    expect(multikey.type).toBe('Multikey');
    expect(multikey.publicKeyMultibase).toStartWith('z');
    expect(multikey.secretKeyMultibase).toStartWith('z');
    expect(multikey.publicKey.length).toBe(96); // G2 point size
    expect(multikey.privateKey!.length).toBe(32); // Private key size
  });

  test('should sign and verify with BLS12-381 key', async () => {
    const multikey = await Multikey.generate(KeyType.Bls12381G2);
    const data = new TextEncoder().encode('Hello, world!');
    const signature = await multikey.sign(data);
    const isValid = await multikey.verify(data, signature);
    expect(isValid).toBe(true);
  });

  test('should fail verification with incorrect data for BLS12-381', async () => {
    const multikey = await Multikey.generate(KeyType.Bls12381G2);
    const data = new TextEncoder().encode('Hello, world!');
    const signature = await multikey.sign(data);
    const incorrectData = new TextEncoder().encode('Hello, World!');
    const isValid = await multikey.verify(incorrectData, signature);
    expect(isValid).toBe(false);
  });
});