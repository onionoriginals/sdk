// Previous-format regression; CEL 3 public behavior is tested in CelV3DefaultJourney.
import { describe, test, expect } from 'bun:test';
import { WebVHManager } from '../../../src/did/WebVHManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { OriginalsSDK } from '../../previous-sdk';
import { Ed25519Signer } from '../../../src/crypto/Signer';
import { multikey } from '@originals/cel';
import { StructuredError } from '@originals/cel';
import type { ExternalSigner, ExternalVerifier } from '../../../src/types';

/**
 * CLAUDE.md gotcha #7: for did:webvh operations provide either keyPair OR
 * externalSigner, not both. Previously passing both silently ignored the
 * keyPair, and the externalSigner path returned a FAKE empty keyPair
 * ({publicKey:'', privateKey:''}) in a result whose docs say the keyPair
 * "must be persisted" — a footgun for callers persisting empty strings.
 */

async function buildMockExternalSigner(keyManager: KeyManager): Promise<{
  signer: ExternalSigner;
  verifier: ExternalVerifier;
  keyPair: { publicKey: string; privateKey: string };
}> {
  const keyPair = await keyManager.generateKeyPair('Ed25519');
  const internalSigner = new Ed25519Signer();
  const mod = await import('didwebvh-ts') as unknown as {
    prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>;
  };
  const { prepareDataForSigning } = mod;

  const signer: ExternalSigner = {
    getVerificationMethodId: () => `did:key:${keyPair.publicKey}`,
    async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }> {
      const dataToSign = await prepareDataForSigning(input.document, input.proof);
      const sig: Buffer = await internalSigner.sign(Buffer.from(dataToSign), keyPair.privateKey);
      return { proofValue: multikey.encodeMultibase(sig) };
    },
  };
  const verifier: ExternalVerifier = {
    async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
      const pubMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
      return internalSigner.verify(Buffer.from(message), Buffer.from(signature), pubMultibase);
    },
  };
  return { signer, verifier, keyPair };
}

describe('keyPair/externalSigner mutual exclusion', () => {
  test('WebVHManager.createDIDWebVH throws a StructuredError when both are provided', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const otherKeyPair = await km.generateKeyPair('Ed25519');

    const manager = new WebVHManager();
    try {
      await manager.createDIDWebVH({
        domain: 'example.com',
        keyPair: otherKeyPair,
        externalSigner: signer,
        externalVerifier: verifier,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
        updateKeys: [keyPair.publicKey],
      });
      throw new Error('expected createDIDWebVH to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).code).toBe('KEYPAIR_AND_EXTERNAL_SIGNER');
    }
  }, 15000);

  test('DIDManager.createDIDWebVH throws when both are provided', async () => {
    const sdk = OriginalsSDK.create();
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const otherKeyPair = await km.generateKeyPair('Ed25519');

    await expect(sdk.did.createDIDWebVH({
      domain: 'example.com',
      keyPair: otherKeyPair,
      externalSigner: signer,
      externalVerifier: verifier,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [keyPair.publicKey],
    })).rejects.toThrow(/either keyPair OR externalSigner/);
  }, 15000);

  test('DIDManager.migrateToDIDWebVH throws when both are provided', async () => {
    const sdk = OriginalsSDK.create();
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const otherKeyPair = await km.generateKeyPair('Ed25519');

    await expect(sdk.did.migrateToDIDWebVH(
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:abc123' },
      'example.com',
      {
        keyPair: otherKeyPair,
        externalSigner: signer,
        externalVerifier: verifier,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
        updateKeys: [keyPair.publicKey],
      }
    )).rejects.toThrow(/either keyPair OR externalSigner/);
  }, 15000);
});

describe('externalSigner result has no fake keyPair', () => {
  test('WebVHManager.createDIDWebVH with externalSigner omits keyPair entirely', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);

    const manager = new WebVHManager();
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      externalSigner: signer,
      externalVerifier: verifier,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [keyPair.publicKey],
    });

    expect(result.did).toMatch(/^did:webvh:/);
    // No fake { publicKey: '', privateKey: '' } — the field is simply absent.
    expect(result.keyPair).toBeUndefined();
    expect('keyPair' in result).toBe(false);
  }, 20000);

  test('DIDManager.createDIDWebVH with externalSigner omits keyPair entirely', async () => {
    const sdk = OriginalsSDK.create();
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);

    const result = await sdk.did.createDIDWebVH({
      domain: 'example.com',
      externalSigner: signer,
      externalVerifier: verifier,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [keyPair.publicKey],
    });

    expect(result.did).toMatch(/^did:webvh:/);
    expect(result.keyPair).toBeUndefined();
  }, 20000);

  test('internal-key path still returns the generated keyPair', async () => {
    const manager = new WebVHManager();
    const result = await manager.createDIDWebVH({ domain: 'example.com' });
    expect(result.keyPair).toBeDefined();
    expect(result.keyPair!.publicKey.length).toBeGreaterThan(0);
    expect(result.keyPair!.privateKey.length).toBeGreaterThan(0);
  }, 20000);
});

describe('DIDManager.createDIDWebVH path-segment validation (delegated to WebVHManager)', () => {
  test('malformed path segments error early', async () => {
    const sdk = OriginalsSDK.create();
    await expect(sdk.did.createDIDWebVH({
      domain: 'example.com',
      paths: ['..', 'x'],
    })).rejects.toThrow(/Invalid path segment/);
  }, 15000);

  // #711: WebVHManager.createDIDWebVH's validation-failure paths must throw
  // a typed StructuredError with a stable .code, matching the public-seam
  // contract CLAUDE.md documents and that createDIDWebVH is named by name
  // as a governed call site for.
  test('malformed path segments throw a StructuredError with a stable code', async () => {
    const manager = new WebVHManager();
    try {
      await manager.createDIDWebVH({ domain: 'example.com', paths: ['..', 'x'] });
      throw new Error('expected createDIDWebVH to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).code).toBe('WEBVH_INVALID_PATH_SEGMENT');
    }
  }, 15000);
});

describe('WebVHManager.createDIDWebVH externalSigner validation (#711)', () => {
  test('prerotation with externalSigner throws WEBVH_PREROTATION_EXTERNAL_SIGNER_UNSUPPORTED', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const manager = new WebVHManager();
    try {
      await manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signer,
        externalVerifier: verifier,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
        updateKeys: [keyPair.publicKey],
        prerotation: true,
      });
      throw new Error('expected createDIDWebVH to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).code).toBe('WEBVH_PREROTATION_EXTERNAL_SIGNER_UNSUPPORTED');
    }
  }, 15000);

  test('missing verificationMethods with externalSigner throws WEBVH_VERIFICATION_METHODS_REQUIRED', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const manager = new WebVHManager();
    try {
      await manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signer,
        externalVerifier: verifier,
        updateKeys: [keyPair.publicKey],
      });
      throw new Error('expected createDIDWebVH to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).code).toBe('WEBVH_VERIFICATION_METHODS_REQUIRED');
    }
  }, 15000);

  test('missing updateKeys with externalSigner throws WEBVH_UPDATE_KEYS_REQUIRED', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const manager = new WebVHManager();
    try {
      await manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signer,
        externalVerifier: verifier,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      });
      throw new Error('expected createDIDWebVH to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).code).toBe('WEBVH_UPDATE_KEYS_REQUIRED');
    }
  }, 15000);

  test('externalSigner without verify() and no externalVerifier throws WEBVH_VERIFIER_REQUIRED', async () => {
    const km = new KeyManager();
    const { keyPair } = await buildMockExternalSigner(km);
    const manager = new WebVHManager();
    const signOnlySigner: ExternalSigner = {
      getVerificationMethodId: () => `did:key:${keyPair.publicKey}`,
      sign: async () => ({ proofValue: '' }),
    };
    try {
      await manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signOnlySigner,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
        updateKeys: [keyPair.publicKey],
      });
      throw new Error('expected createDIDWebVH to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      // Same code identity-operations.ts's resolveVerifier and
      // updateDIDWebVH use for the identical condition (#720).
      expect((err as StructuredError).code).toBe('WEBVH_VERIFIER_REQUIRED');
    }
  }, 15000);

  test('malformed externalSigner updateKeys throws WEBVH_UPDATE_KEY_INVALID', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const manager = new WebVHManager();
    try {
      await manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signer,
        externalVerifier: verifier,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
        updateKeys: ['not-a-valid-multikey'],
      });
      throw new Error('expected createDIDWebVH to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).code).toBe('WEBVH_UPDATE_KEY_INVALID');
    }
  }, 15000);

  test('non-Ed25519 externalSigner updateKeys throws WEBVH_UPDATE_KEY_NOT_ED25519', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const secp256k1KeyPair = await km.generateKeyPair('ES256K');
    const manager = new WebVHManager();
    try {
      await manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signer,
        externalVerifier: verifier,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
        updateKeys: [secp256k1KeyPair.publicKey],
      });
      throw new Error('expected createDIDWebVH to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).code).toBe('WEBVH_UPDATE_KEY_NOT_ED25519');
    }
  }, 15000);
});
