// Previous-format regression; CEL 3 public behavior is tested in CelV3DefaultJourney.
/**
 * Regression tests for issue #702: WebVHManager.updateDIDWebVH omitted the
 * signer-as-verifier fallback that createDIDWebVH already has. A signer that
 * implements both ExternalSigner and ExternalVerifier (the documented
 * pattern in packages/sdk/V3.md, and the exact shape of
 * TurnkeyWebVHSigner/TurnkeyDIDSigner) worked on createDIDWebVH without a
 * separate `verifier` argument, but threw on updateDIDWebVH with the
 * identical signer.
 */
import { describe, test, expect } from 'bun:test';
import { WebVHManager } from '../../../src/did/WebVHManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { Ed25519Signer } from '../../../src/crypto/Signer';
import { multikey } from '@originals/cel';
import type { ExternalSigner, ExternalVerifier } from '../../../src/types';

/** A signer that ALSO implements verify — mirrors TurnkeyWebVHSigner's shape. */
async function buildDualSignerVerifier(keyManager: KeyManager): Promise<{
  signer: ExternalSigner & ExternalVerifier;
  keyPair: { publicKey: string; privateKey: string };
}> {
  const keyPair = await keyManager.generateKeyPair('Ed25519');
  const internalSigner = new Ed25519Signer();
  const mod = await import('didwebvh-ts') as unknown as {
    prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>;
  };
  const { prepareDataForSigning } = mod;

  const signer: ExternalSigner & ExternalVerifier = {
    getVerificationMethodId: () => `did:key:${keyPair.publicKey}`,
    async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }> {
      const dataToSign = await prepareDataForSigning(input.document, input.proof);
      const sig: Buffer = await internalSigner.sign(Buffer.from(dataToSign), keyPair.privateKey);
      return { proofValue: multikey.encodeMultibase(sig) };
    },
    async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
      const pubMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
      return internalSigner.verify(Buffer.from(message), Buffer.from(signature), pubMultibase);
    },
  };
  return { signer, keyPair };
}

describe('#702 — updateDIDWebVH falls back to the signer as verifier', () => {
  test('a dual signer/verifier works on updateDIDWebVH without a separate verifier option', async () => {
    const manager = new WebVHManager();
    const km = new KeyManager();
    const { signer, keyPair } = await buildDualSignerVerifier(km);

    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      externalSigner: signer,
      externalVerifier: signer,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [keyPair.publicKey],
    });

    const newService = {
      id: `${created.did}#files`,
      type: 'LinkedDomains',
      serviceEndpoint: 'https://files.example.com',
    };

    // verifier intentionally omitted — createDIDWebVH's fallback accepted
    // this same dual object without one; updateDIDWebVH must too.
    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { service: [newService] },
      signer,
    });

    expect(updated.didDocument.service).toEqual([newService]);
  }, 30000);

  test('DIDManager.updateDIDWebVH (delegated) also accepts the dual signer without a separate verifier', async () => {
    const { OriginalsSDK } = await import('../../previous-sdk');
    const sdk = OriginalsSDK.create();
    const km = new KeyManager();
    const { signer, keyPair } = await buildDualSignerVerifier(km);

    const created = await sdk.did.createDIDWebVH({
      domain: 'example.com',
      externalSigner: signer,
      externalVerifier: signer,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [keyPair.publicKey],
    });

    const updated = await sdk.did.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { alsoKnownAs: ['did:example:123'] },
      signer,
    });

    expect(updated.didDocument.alsoKnownAs).toEqual(['did:example:123']);
  }, 30000);

  test('a signer without verify() still requires an explicit verifier, with a clear error', async () => {
    const manager = new WebVHManager();
    const km = new KeyManager();
    const { signer, keyPair } = await buildDualSignerVerifier(km);
    // Strip verify to simulate a signer that truly cannot verify.
    const signOnly: ExternalSigner = { getVerificationMethodId: signer.getVerificationMethodId, sign: signer.sign };

    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      externalSigner: signOnly,
      externalVerifier: signer,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [keyPair.publicKey],
    });

    await expect(manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { alsoKnownAs: ['did:example:456'] },
      signer: signOnly,
    })).rejects.toThrow(/verifier is required when the provided signer does not implement verify/);
  }, 30000);
});
