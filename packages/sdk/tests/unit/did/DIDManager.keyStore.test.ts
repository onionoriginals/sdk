/**
 * Issue #824 — `config.keyStore` was accepted and stored by the default SDK
 * but never read by `sdk.did`: a locally generated did:webvh signing key was
 * only ever handed back on the result for the caller to persist themselves,
 * even when a keyStore was explicitly configured. `createDIDWebVH` and
 * `migrateToDIDWebVH` now persist a freshly generated (or caller-supplied)
 * local key pair into the configured `keyStore`, registered under both the
 * did:webvh signing verification method id and its did:key form.
 */
import { describe, test, expect } from 'bun:test';
import { DIDManager } from '../../../src/did/DIDManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { Ed25519Signer } from '../../../src/crypto/Signer';
import { multikey } from '@originals/cel';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import type { OriginalsConfig, ExternalSigner, ExternalVerifier } from '../../../src/types';

/** Mirrors WebVHManager.signer-exclusivity.test.ts's mock external signer. */
async function buildMockExternalSigner(keyManager: KeyManager): Promise<{
  signer: ExternalSigner;
  verifier: ExternalVerifier;
  keyPair: { publicKey: string; privateKey: string };
}> {
  const keyPair = await keyManager.generateKeyPair('Ed25519');
  const internalSigner = new Ed25519Signer();
  const mod = (await import('didwebvh-ts')) as unknown as {
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

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

describe('#824 — createDIDWebVH persists a locally generated key into config.keyStore', () => {
  test('registers the generated key under the did:webvh signing VM and its did:key form', async () => {
    const keyStore = new MockKeyStore();
    const manager = new DIDManager({ ...baseConfig, keyStore });

    const result = await manager.createDIDWebVH({ domain: 'example.com', paths: ['alice'] });
    expect(result.keyPair).toBeDefined();

    const signingVmId = result.didDocument.verificationMethod?.[0]?.id;
    expect(signingVmId).toBeTruthy();
    const absoluteVmId = `${result.did}${signingVmId}`;
    const stored = await keyStore.getPrivateKey(absoluteVmId);
    expect(stored).toBe(result.keyPair!.privateKey);

    const didKeyVmId = `did:key:${result.keyPair!.publicKey}#${result.keyPair!.publicKey}`;
    const storedByDidKey = await keyStore.getPrivateKey(didKeyVmId);
    expect(storedByDidKey).toBe(result.keyPair!.privateKey);
  }, 15000);

  test('persists a caller-supplied keyPair too, not only a generated one', async () => {
    const keyStore = new MockKeyStore();
    const manager = new DIDManager({ ...baseConfig, keyStore });
    const suppliedKeyPair = await new KeyManager().generateKeyPair('Ed25519');

    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      paths: ['bob'],
      keyPair: suppliedKeyPair,
    });

    const didKeyVmId = `did:key:${suppliedKeyPair.publicKey}#${suppliedKeyPair.publicKey}`;
    expect(await keyStore.getPrivateKey(didKeyVmId)).toBe(suppliedKeyPair.privateKey);
  }, 15000);

  test('does not touch the keyStore when an externalSigner is used', async () => {
    const keyStore = new MockKeyStore();
    const manager = new DIDManager({ ...baseConfig, keyStore });
    const { signer, verifier, keyPair } = await buildMockExternalSigner(new KeyManager());

    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      paths: ['carol'],
      externalSigner: signer,
      externalVerifier: verifier,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [keyPair.publicKey],
    });

    expect(result.keyPair).toBeUndefined();
    expect(keyStore.getAllVerificationMethodIds()).toHaveLength(0);
  }, 20000);

  test('is a no-op when no keyStore is configured (no throw)', async () => {
    const manager = new DIDManager({ ...baseConfig });
    const result = await manager.createDIDWebVH({ domain: 'example.com', paths: ['dave'] });
    expect(result.keyPair).toBeDefined();
  }, 15000);
});

describe('#824 — migrateToDIDWebVH persists the generated update key into config.keyStore', () => {
  test('registers the migrated key under its did:key form', async () => {
    const keyStore = new MockKeyStore();
    const manager = new DIDManager({ ...baseConfig, keyStore });
    const sourceDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:cel:migrate-824',
    };

    const result = await manager.migrateToDIDWebVH(sourceDoc as any, 'example.com');
    expect(result.keyPair).toBeDefined();

    const didKeyVmId = `did:key:${result.keyPair!.publicKey}#${result.keyPair!.publicKey}`;
    expect(await keyStore.getPrivateKey(didKeyVmId)).toBe(result.keyPair!.privateKey);
  }, 15000);
});
