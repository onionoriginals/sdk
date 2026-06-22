/**
 * CredentialManager - External Signer Error Propagation Tests
 *
 * Covers:
 * - VC-003/error: External signer call fails → CredentialManager propagates the rejection
 */

import { describe, test, expect } from 'bun:test';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import type { VerifiableCredential, ExternalSigner, OriginalsConfig } from '../../../src/types';

const defaultConfig: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

const baseVC: VerifiableCredential = {
  '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
  type: ['VerifiableCredential', 'ResourceCreated'],
  issuer: 'did:peer:issuer',
  issuanceDate: new Date().toISOString(),
  credentialSubject: {
    id: 'did:peer:subject',
    resourceId: 'res-001',
    resourceType: 'text',
    creator: 'did:peer:issuer',
    createdAt: new Date().toISOString(),
  } as any,
};

describe('CredentialManager.signCredentialWithExternalSigner - error propagation [VC-003]', () => {
  test('propagates rejection from signer.sign()', async () => {
    const manager = new CredentialManager(defaultConfig);

    const failingSigner: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkTestKey#z6MkTestKey',
      sign: async () => {
        throw new Error('HSM unavailable');
      },
    };

    await expect(
      manager.signCredentialWithExternalSigner(baseVC, failingSigner)
    ).rejects.toThrow('HSM unavailable');
  });

  test('propagates rejection with the original error type (not wrapped)', async () => {
    const manager = new CredentialManager(defaultConfig);

    class CustomSignerError extends Error {
      constructor(public code: number, msg: string) {
        super(msg);
        this.name = 'CustomSignerError';
      }
    }

    const failingSigner: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkOther#z6MkOther',
      sign: async () => {
        throw new CustomSignerError(503, 'Signer service timeout');
      },
    };

    const rejection = manager.signCredentialWithExternalSigner(baseVC, failingSigner);
    await expect(rejection).rejects.toBeInstanceOf(CustomSignerError);
    await expect(rejection).rejects.toThrow('Signer service timeout');
  });

  test('propagates rejection when signer.sign() rejects with a string reason', async () => {
    const manager = new CredentialManager(defaultConfig);

    const failingSigner: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkReject#z6MkReject',
      // Explicitly returns a rejected promise without throwing
      sign: () => Promise.reject(new Error('Network error from KMS')),
    };

    await expect(
      manager.signCredentialWithExternalSigner(baseVC, failingSigner)
    ).rejects.toThrow('Network error from KMS');
  });

  test('succeeds when signer returns a valid proofValue', async () => {
    const manager = new CredentialManager(defaultConfig);

    const vmId = 'did:key:z6MkGoodKey#z6MkGoodKey';
    const successSigner: ExternalSigner = {
      getVerificationMethodId: () => vmId,
      sign: async ({ document, proof }) => {
        // Must receive the unsigned credential document and proof base
        expect(document).toBeDefined();
        expect((proof as any).type).toBe('DataIntegrityProof');
        return { proofValue: 'zFakeValidProofValue' };
      },
    };

    const signed = await manager.signCredentialWithExternalSigner(baseVC, successSigner);

    expect(signed.proof).toBeDefined();
    const proof = signed.proof as any;
    expect(proof.proofValue).toBe('zFakeValidProofValue');
    expect(proof.verificationMethod).toBe(vmId);
    expect(proof.type).toBe('DataIntegrityProof');
    expect(proof.proofPurpose).toBe('assertionMethod');
  });

  test('does not include original proof on input document passed to signer.sign()', async () => {
    const manager = new CredentialManager(defaultConfig);

    // Start from a VC that already has a proof (re-signing case)
    const vcWithExistingProof: VerifiableCredential = {
      ...baseVC,
      proof: {
        type: 'DataIntegrityProof',
        created: '2024-01-01T00:00:00Z',
        verificationMethod: 'did:key:oldKey#oldKey',
        proofPurpose: 'assertionMethod',
        proofValue: 'zOldProofValue',
      } as any,
    };

    let capturedDocument: Record<string, unknown> | undefined;

    const signer: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkNew#z6MkNew',
      sign: async ({ document }) => {
        capturedDocument = document;
        return { proofValue: 'zNewProof' };
      },
    };

    await manager.signCredentialWithExternalSigner(vcWithExistingProof, signer);

    // The document passed to the signer must NOT contain the old proof
    expect(capturedDocument).toBeDefined();
    expect(capturedDocument!['proof']).toBeUndefined();
  });

  test('propagates rejection from signer.sign() even with async delay', async () => {
    const manager = new CredentialManager(defaultConfig);

    const delayedFailingSigner: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkDelayed#z6MkDelayed',
      sign: () =>
        new Promise<never>((_, reject) => {
          // Simulate async network call that eventually fails
          setTimeout(() => reject(new Error('Delayed HSM failure')), 10);
        }),
    };

    await expect(
      manager.signCredentialWithExternalSigner(baseVC, delayedFailingSigner)
    ).rejects.toThrow('Delayed HSM failure');
  });
});
