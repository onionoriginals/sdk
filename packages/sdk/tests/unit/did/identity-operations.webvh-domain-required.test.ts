/**
 * #678 — createDIDOriginal/updateDIDOriginal must never mint or move a
 * did:webvh Original at a blank/whitespace-only or (for update) silently
 * dropped-empty domain.
 *
 * #531 already made DIDManager.createDIDWebVH/migrateToDIDWebVH refuse to
 * guess a domain. These standalone identity-operations.ts helpers
 * (createDIDOriginal, updateDIDOriginal) are a second, independent call path
 * into didwebvh-ts and did not share that guard: a whitespace-only domain
 * was forwarded straight through and silently minted an unresolvable
 * did:webvh with literal spaces embedded in its identifier, and on update an
 * explicitly empty-string domain was silently swallowed as a no-op move
 * instead of erroring.
 */

import { describe, test, expect } from 'bun:test';
import { StructuredError } from '@originals/cel';
import { createDIDOriginal, updateDIDOriginal } from '../../../src/did/identity-operations.js';

/** Assert the thrown value is the named domain-required StructuredError. */
async function expectDomainRequired(fn: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(StructuredError);
  expect((thrown as StructuredError).code).toBe('WEBVH_DOMAIN_REQUIRED');
}

async function makeSigner() {
  const { KeyManager } = await import('../../../src/did/KeyManager.js');
  const { Ed25519Signer } = await import('../../../src/crypto/Signer.js');
  const { multikey } = await import('@originals/cel');
  const { prepareDataForSigning } = await import('didwebvh-ts');

  const keyManager = new KeyManager();
  const internalSigner = new Ed25519Signer();
  const keyPair = await keyManager.generateKeyPair('Ed25519');
  const vmId = `did:key:${keyPair.publicKey}`;
  const signer = {
    getVerificationMethodId: () => vmId,
    async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }) {
      const dataToSign = await prepareDataForSigning(input.document, input.proof);
      const sig: Buffer = await internalSigner.sign(Buffer.from(dataToSign), keyPair.privateKey);
      return { proofValue: multikey.encodeMultibase(sig) };
    },
    async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) {
      const pubMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
      return internalSigner.verify(Buffer.from(message), Buffer.from(signature), pubMultibase);
    },
  };
  return { signer, keyPair, vmId };
}

describe('#678 — createDIDOriginal refuses to guess/mint at a blank domain', () => {
  test.each(['   ', '\t'])(
    'throws WEBVH_DOMAIN_REQUIRED for domain=%j before any signing work',
    async (domain) => {
      const { signer, keyPair } = await makeSigner();
      await expectDomainRequired(() =>
        createDIDOriginal({
          type: 'did',
          domain,
          signer: signer as any,
          verifier: signer as any,
          updateKeys: [keyPair.publicKey],
          verificationMethods: [
            { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
          ],
        }),
      );
    },
  );

  test('an explicit valid domain still mints a did:webvh', async () => {
    const { signer, keyPair } = await makeSigner();
    const result = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: signer as any,
      verifier: signer as any,
      updateKeys: [keyPair.publicKey],
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
      ],
    });
    expect(result.did).toMatch(/^did:webvh:/);
    expect(result.did).toContain('example.com');
  }, 20000);

  // #764: a padded (non-blank) domain used to mint a DID with literal
  // whitespace embedded in it instead of being trimmed.
  test('a padded domain is trimmed rather than minting whitespace into the DID (#764)', async () => {
    const { signer, keyPair } = await makeSigner();
    const result = await createDIDOriginal({
      type: 'did',
      domain: '  example.com  ',
      signer: signer as any,
      verifier: signer as any,
      updateKeys: [keyPair.publicKey],
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
      ],
    });
    expect(result.did).toMatch(/:example\.com$/);
    expect(result.did).not.toContain(' ');
  }, 20000);
});

describe('#678 — updateDIDOriginal refuses to guess/mint or silently drop a domain move', () => {
  test.each(['   ', '\t', ''])(
    'throws WEBVH_DOMAIN_REQUIRED for domain=%j instead of minting garbage or silently no-oping the move',
    async (domain) => {
      const { signer, keyPair } = await makeSigner();
      const created = await createDIDOriginal({
        type: 'did',
        domain: 'example.com',
        signer: signer as any,
        verifier: signer as any,
        updateKeys: [keyPair.publicKey],
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
        ],
      });
      await expectDomainRequired(() =>
        updateDIDOriginal({
          type: 'did',
          log: created.log,
          signer: signer as any,
          verifier: signer as any,
          domain,
        }),
      );
    },
  );

  test('an explicit new domain still moves the did:webvh', async () => {
    const { signer, keyPair } = await makeSigner();
    const created = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: signer as any,
      verifier: signer as any,
      updateKeys: [keyPair.publicKey],
      portable: true,
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
      ],
    });
    const updated = await updateDIDOriginal({
      type: 'did',
      log: created.log,
      signer: signer as any,
      verifier: signer as any,
      domain: 'moved.example.com',
    });
    expect(updated.did).toContain('moved.example.com');
  }, 20000);

  // #764: updateDIDOriginal shares requireWebVHDomain with createDIDOriginal,
  // so a padded new domain must be trimmed rather than minting whitespace
  // into the moved DID.
  test('a padded new domain is trimmed rather than minting whitespace into the moved DID (#764)', async () => {
    const { signer, keyPair } = await makeSigner();
    const created = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: signer as any,
      verifier: signer as any,
      updateKeys: [keyPair.publicKey],
      portable: true,
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
      ],
    });
    const updated = await updateDIDOriginal({
      type: 'did',
      log: created.log,
      signer: signer as any,
      verifier: signer as any,
      domain: '  moved.example.com  ',
    });
    expect(updated.did).toMatch(/:moved\.example\.com$/);
    expect(updated.did).not.toContain(' ');
  }, 20000);

  test('omitting domain entirely still updates without requiring one', async () => {
    const { signer, keyPair } = await makeSigner();
    const created = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: signer as any,
      verifier: signer as any,
      updateKeys: [keyPair.publicKey],
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
      ],
    });
    const updated = await updateDIDOriginal({
      type: 'did',
      log: created.log,
      signer: signer as any,
      verifier: signer as any,
    });
    expect(updated.did).toBe(created.did);
  }, 20000);
});

// #792 — updateDIDOriginal used to resolve/validate the verifier before
// validating domain, so a blank/whitespace domain combined with a signer
// that doesn't implement verify() threw WEBVH_VERIFIER_REQUIRED instead of
// WEBVH_DOMAIN_REQUIRED, masking the domain problem. createDIDOriginal
// already got this ordering right (domain checked before the verifier is
// resolved); updateDIDOriginal now matches it.
describe('#792 — updateDIDOriginal validates domain before resolving the verifier', () => {
  /** A signer that can sign but does not implement verify() — the ordering bug only reproduces with this shape. */
  async function makeSignOnlySigner() {
    const { signer, keyPair } = await makeSigner();
    const signOnly = { getVerificationMethodId: signer.getVerificationMethodId, sign: signer.sign };
    return { signer: signOnly, keyPair };
  }

  test.each(['', '   ', '\t'])(
    'a sign-only signer with domain=%j still throws WEBVH_DOMAIN_REQUIRED, not WEBVH_VERIFIER_REQUIRED',
    async (domain) => {
      const { signer: verifyingSigner, keyPair } = await makeSigner();
      const created = await createDIDOriginal({
        type: 'did',
        domain: 'example.com',
        signer: verifyingSigner as any,
        verifier: verifyingSigner as any,
        updateKeys: [keyPair.publicKey],
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
        ],
      });
      const { signer: signOnlySigner } = await makeSignOnlySigner();
      await expectDomainRequired(() =>
        updateDIDOriginal({
          type: 'did',
          log: created.log,
          signer: signOnlySigner as any,
          domain,
        }),
      );
    },
  );

  // Control: with an omitted/valid domain, a sign-only signer still throws
  // WEBVH_VERIFIER_REQUIRED as before — this PR only reorders the checks,
  // it does not bypass the verifier requirement.
  test('a sign-only signer with a valid or omitted domain still throws WEBVH_VERIFIER_REQUIRED', async () => {
    const { signer: verifyingSigner, keyPair } = await makeSigner();
    const created = await createDIDOriginal({
      type: 'did',
      domain: 'example.com',
      signer: verifyingSigner as any,
      verifier: verifyingSigner as any,
      updateKeys: [keyPair.publicKey],
      verificationMethods: [
        { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
      ],
    });
    const { signer: signOnlySigner } = await makeSignOnlySigner();

    async function expectVerifierRequired(fn: () => Promise<unknown>): Promise<void> {
      let thrown: unknown;
      try {
        await fn();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StructuredError);
      expect((thrown as StructuredError).code).toBe('WEBVH_VERIFIER_REQUIRED');
    }

    await expectVerifierRequired(() =>
      updateDIDOriginal({ type: 'did', log: created.log, signer: signOnlySigner as any }),
    );
    await expectVerifierRequired(() =>
      updateDIDOriginal({
        type: 'did',
        log: created.log,
        signer: signOnlySigner as any,
        domain: 'moved.example.com',
      }),
    );
  }, 20000);
});
