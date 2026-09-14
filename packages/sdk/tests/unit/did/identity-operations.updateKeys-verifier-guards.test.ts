/**
 * #714 — createDIDOriginal/updateDIDOriginal skip the SDK's own Ed25519-only
 * did:webvh updateKeys check (WebVHManager.assertEd25519WebVHUpdateKeys).
 * A non-Ed25519 updateKey signs successfully at create/update time but,
 * per the SDK's own documented invariant, can never resolve afterward
 * (did:webvh log resolution is Ed25519-only). It must be rejected up front.
 *
 * #719 — createDIDOriginal/updateDIDOriginal's signer-as-verifier fallback
 * has no verify() capability guard: `verifier: options.verifier ||
 * options.signer` silently casts a sign-only signer to a verifier, which
 * makes didwebvh-ts fail deep inside with a raw third-party
 * "verifier.verify is not a function" TypeError instead of a clear error at
 * this seam. Mirrors the guard WebVHManager.createDIDWebVH already applies.
 */

import { describe, test, expect } from 'bun:test';
import { StructuredError } from '@originals/cel';
import { createDIDOriginal, updateDIDOriginal } from '../../../src/did/identity-operations';

/** Assert the thrown value is the named StructuredError. */
async function expectStructuredError(fn: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(StructuredError);
  expect((thrown as StructuredError).code).toBe(code);
}

async function makeSigner(keyType: 'Ed25519' | 'ES256K' = 'Ed25519') {
  const { KeyManager } = await import('../../../src/did/KeyManager');
  const { Ed25519Signer } = await import('../../../src/crypto/Signer');
  const { multikey } = await import('@originals/cel');
  const { prepareDataForSigning } = await import('didwebvh-ts');

  const keyManager = new KeyManager();
  const internalSigner = new Ed25519Signer();
  // Ed25519 keys are used to actually sign (the internal signer is
  // Ed25519-only); the caller supplies whichever multikey it wants to test
  // as the *updateKey* independently of what actually signs the entry.
  const signingKeyPair = await keyManager.generateKeyPair('Ed25519');
  const updateKeyPair =
    keyType === 'Ed25519' ? signingKeyPair : await keyManager.generateKeyPair(keyType);
  const vmId = `did:key:${signingKeyPair.publicKey}`;

  const signer = {
    getVerificationMethodId: () => vmId,
    async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }) {
      const dataToSign = await prepareDataForSigning(input.document, input.proof);
      const sig: Buffer = await internalSigner.sign(Buffer.from(dataToSign), signingKeyPair.privateKey);
      return { proofValue: multikey.encodeMultibase(sig) };
    },
    async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) {
      const pubMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
      return internalSigner.verify(Buffer.from(message), Buffer.from(signature), pubMultibase);
    },
  };
  return { signer, signingKeyPair, updateKeyPair, vmId };
}

describe('#714 — Ed25519-only updateKeys guard on createDIDOriginal/updateDIDOriginal', () => {
  test('createDIDOriginal rejects a non-Ed25519 (Secp256k1) updateKey before signing', async () => {
    const { signer, signingKeyPair, updateKeyPair } = await makeSigner('ES256K');
    await expect(
      createDIDOriginal({
        type: 'did',
        domain: 'example.com',
        signer: signer as any,
        verifier: signer as any,
        updateKeys: [updateKeyPair.publicKey],
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: signingKeyPair.publicKey },
        ],
      }),
    ).rejects.toThrow(/Ed25519/);
  });

  test('createDIDOriginal accepts a legacy did:key-form Ed25519 updateKey (normalize before validate)', async () => {
    const { signer, signingKeyPair, updateKeyPair } = await makeSigner('Ed25519');
    const result = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: signer as any,
      verifier: signer as any,
      updateKeys: [`did:key:${updateKeyPair.publicKey}`],
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: signingKeyPair.publicKey },
      ],
    });
    expect(result.did).toMatch(/^did:webvh:/);
  }, 20000);

  test('updateDIDOriginal rejects a non-Ed25519 (Secp256k1) updateKey before signing', async () => {
    const { signer, signingKeyPair, updateKeyPair: ed25519UpdateKey } = await makeSigner('Ed25519');
    const created = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: signer as any,
      verifier: signer as any,
      updateKeys: [ed25519UpdateKey.publicKey],
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: signingKeyPair.publicKey },
      ],
    });

    const { updateKeyPair: secp256k1UpdateKey } = await makeSigner('ES256K');
    await expect(
      updateDIDOriginal({
        type: 'did',
        log: created.log,
        signer: signer as any,
        verifier: signer as any,
        updateKeys: [secp256k1UpdateKey.publicKey],
      }),
    ).rejects.toThrow(/Ed25519/);
  }, 20000);
});

describe('#719 — signer-as-verifier fallback requires verify() capability', () => {
  test('createDIDOriginal throws a clear error for a sign-only signer with no explicit verifier', async () => {
    const { signingKeyPair } = await makeSigner('Ed25519');
    const signOnlySigner = {
      sign: async (_input: unknown) => ({ proofValue: 'zSignature' }),
      getVerificationMethodId: () => `did:key:${signingKeyPair.publicKey}`,
      // no verify() — matches the documented public ExternalSigner interface exactly
    };
    await expectStructuredError(
      () =>
        createDIDOriginal({
          type: 'did',
          domain: 'example.com',
          signer: signOnlySigner as any,
          updateKeys: [signingKeyPair.publicKey],
          verificationMethods: [
            { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: signingKeyPair.publicKey },
          ],
        }),
      'WEBVH_VERIFIER_REQUIRED',
    );
  });

  test('updateDIDOriginal throws a clear error for a sign-only signer with no explicit verifier', async () => {
    const { signer, signingKeyPair } = await makeSigner('Ed25519');
    const created = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: signer as any,
      verifier: signer as any,
      updateKeys: [signingKeyPair.publicKey],
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: signingKeyPair.publicKey },
      ],
    });

    const signOnlySigner = {
      sign: async (_input: unknown) => ({ proofValue: 'zSignature' }),
      getVerificationMethodId: () => `did:key:${signingKeyPair.publicKey}`,
    };
    await expectStructuredError(
      () =>
        updateDIDOriginal({
          type: 'did',
          log: created.log,
          signer: signOnlySigner as any,
        }),
      'WEBVH_VERIFIER_REQUIRED',
    );
  }, 20000);

  test('createDIDOriginal still succeeds when the signer implements verify() and no explicit verifier is given', async () => {
    const { signer, signingKeyPair } = await makeSigner('Ed25519');
    const result = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: signer as any,
      // no explicit verifier: signer implements verify(), fallback should work
      updateKeys: [signingKeyPair.publicKey],
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: signingKeyPair.publicKey },
      ],
    });
    expect(result.did).toMatch(/^did:webvh:/);
  }, 20000);
});
