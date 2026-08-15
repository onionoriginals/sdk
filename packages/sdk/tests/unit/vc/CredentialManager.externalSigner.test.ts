/**
 * CredentialManager — external signer path.
 *
 * Covers:
 * - VC-003/error: external signer call fails → CredentialManager propagates the rejection
 * - Plan 036: the SDK canonicalizes and hashes; the signer signs those bytes.
 *
 * Before 036 this method hardcoded `cryptosuite: 'eddsa-rdfc-2022'` and then
 * called `signer.sign({document, proof})`, letting the signer pick its own
 * canonicalization. Every didwebvh-shaped signer picks JCS, so the proof was
 * labelled RDFC and signed over JCS bytes — the SDK's own verifier rejected
 * 100% of them, with no error at sign time. These tests previously asserted
 * that broken behavior was correct (they accepted `'zFakeValidProofValue'` as
 * a proof), which is why nothing caught it.
 */

import { describe, test, expect } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { multikey } from '@originals/cel';
import type { VerifiableCredential, ExternalSigner, OriginalsConfig } from '../../../src/types';

const defaultConfig: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

function makeManager(): CredentialManager {
  return new CredentialManager(defaultConfig, new DIDManager(defaultConfig as never));
}

/** A remote-custody signer: holds a key, exposes ONLY signBytes. */
function makeRemoteSigner() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKeyMultibase = multikey.encodePublicKey(ed25519.getPublicKey(privateKey), 'Ed25519');
  const did = `did:key:${publicKeyMultibase}`;
  const verificationMethodId = `${did}#${publicKeyMultibase}`;

  const signer: ExternalSigner = {
    getVerificationMethodId: () => verificationMethodId,
    sign: async () => {
      throw new Error('document-level sign() must not be used for credentials');
    },
    signBytes: async (data: Uint8Array) => ({ signature: ed25519.sign(data, privateKey) }),
  };
  return { signer, verificationMethodId, did };
}

/**
 * A credential issued BY `issuer`. The issuer must be the DID that controls the
 * signing key: signing binds the two, so a mismatch is refused (see the
 * issuer-binding tests below).
 */
function makeVC(issuer: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://originals.build/context'],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer,
    validFrom: new Date().toISOString(),
    credentialSubject: {
      id: 'did:peer:subject',
      resourceId: 'res-001',
      resourceType: 'text',
      creator: issuer,
      createdAt: new Date().toISOString(),
    } as never,
  };
}

/** Issued by the DID in the failing signers' verification methods below. */
const vcFor = (vmId: string) => makeVC(vmId.split('#')[0]);

describe('signCredentialWithExternalSigner — signer contract [plan 036]', () => {
  test('rejects a sign()-only signer instead of emitting an unverifiable credential', async () => {
    const manager = makeManager();

    const signOnly: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkTestKey#z6MkTestKey',
      sign: async () => ({ proofValue: 'zFakeValidProofValue' }),
    };

    const rejection = manager.signCredentialWithExternalSigner(
      vcFor('did:key:z6MkTestKey#z6MkTestKey'), signOnly);
    await expect(rejection).rejects.toMatchObject({ code: 'EXTERNAL_SIGNER_SIGNBYTES_REQUIRED' });
    await expect(rejection).rejects.toThrow(/must implement signBytes/);
  });

  test('the rejection explains why a sign()-only signature could never verify', async () => {
    const manager = makeManager();
    const signOnly: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkTestKey#z6MkTestKey',
      sign: async () => ({ proofValue: 'zFake' }),
    };

    const err = await manager
      .signCredentialWithExternalSigner(vcFor('did:key:z6MkTestKey#z6MkTestKey'), signOnly)
      .catch((e) => e);
    expect(err.message).toContain('JCS');
    expect(err.message).toContain('can never verify');
  });

  test('rejects a signature that is not 64 bytes', async () => {
    const manager = makeManager();
    const shortSigner: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkShort#z6MkShort',
      sign: async () => ({ proofValue: 'z' }),
      signBytes: async () => ({ signature: new Uint8Array(32) }),
    };

    const rejection = manager.signCredentialWithExternalSigner(
      vcFor('did:key:z6MkShort#z6MkShort'), shortSigner);
    await expect(rejection).rejects.toMatchObject({ code: 'EXTERNAL_SIGNER_INVALID_SIGNATURE' });
    await expect(rejection).rejects.toThrow(/got 32 bytes/);
  });

  test('signs over the bytes the SDK computed, and emits an RDFC proof', async () => {
    const manager = makeManager();
    const { signer, verificationMethodId, did } = makeRemoteSigner();

    let received: Uint8Array | undefined;
    const spy: ExternalSigner = {
      ...signer,
      signBytes: async (data) => {
        received = data;
        return signer.signBytes!(data);
      },
    };

    const signed = await manager.signCredentialWithExternalSigner(makeVC(did), spy);
    const proof = signed.proof as Record<string, unknown>;

    // The signer received a hash, not a document — canonicalization is the SDK's job.
    expect(received).toBeInstanceOf(Uint8Array);
    expect(received!.length).toBe(64); // RDFC-2022 hashData: sha256(proofConfig) || sha256(document)

    expect(proof.type).toBe('DataIntegrityProof');
    expect(proof.cryptosuite).toBe('eddsa-rdfc-2022');
    expect(proof.verificationMethod).toBe(verificationMethodId);
    expect(proof.proofPurpose).toBe('assertionMethod');
    expect(proof.proofValue).toMatch(/^z/);
    // The hashing @context must not leak onto the emitted proof.
    expect(proof['@context']).toBeUndefined();
  });

  test('an existing proof is excluded from the signed document (re-signing)', async () => {
    const manager = makeManager();
    const { signer, did } = makeRemoteSigner();
    const baseVC = makeVC(did);

    const withOldProof: VerifiableCredential = {
      ...baseVC,
      proof: {
        type: 'DataIntegrityProof',
        created: '2024-01-01T00:00:00Z',
        verificationMethod: 'did:key:oldKey#oldKey',
        proofPurpose: 'assertionMethod',
        proofValue: 'zOldProofValue',
      } as never,
    };

    let bytesWithOldProof: Uint8Array | undefined;
    let bytesWithout: Uint8Array | undefined;

    await manager.signCredentialWithExternalSigner(withOldProof, {
      ...signer,
      signBytes: async (d) => ((bytesWithOldProof = d), signer.signBytes!(d)),
    });
    await manager.signCredentialWithExternalSigner(baseVC, {
      ...signer,
      signBytes: async (d) => ((bytesWithout = d), signer.signBytes!(d)),
    });

    // hashData is sha256(proofConfig) || sha256(document). The document half must
    // match: identical bytes prove the stale proof never entered the hash. (The
    // proofConfig half differs — each call stamps its own `created`.)
    const docHash = (b: Uint8Array) => Buffer.from(b.slice(32)).toString('hex');
    expect(docHash(bytesWithOldProof!)).toBe(docHash(bytesWithout!));
  });
});

describe('signCredentialWithExternalSigner — issuer binding', () => {
  test('refuses to sign a credential claiming an issuer the key does not control', async () => {
    const manager = makeManager();
    const { signer } = makeRemoteSigner();

    // A holder of THIS key minting a credential that claims someone else issued it.
    const impersonating = makeVC('did:webvh:example.com:victim');

    const rejection = manager.signCredentialWithExternalSigner(impersonating, signer);
    await expect(rejection).rejects.toMatchObject({ code: 'ISSUER_BINDING_MISMATCH' });
  });

  test('matches the local-key path: same failure, same code', async () => {
    // Issuer.issueCredential refuses the same mismatch with the same typed code,
    // so isSecuritySigningRefusal treats both paths identically.
    const manager = makeManager();
    const { signer } = makeRemoteSigner();
    const err = await manager
      .signCredentialWithExternalSigner(makeVC('did:webvh:example.com:victim'), signer)
      .catch((e) => e);

    expect(err.message).toContain('does not match the verification method controller');
  });

  test('an issuer matching the signing key is accepted', async () => {
    const manager = makeManager();
    const { signer, did } = makeRemoteSigner();

    const signed = await manager.signCredentialWithExternalSigner(makeVC(did), signer);
    expect((signed.proof as Record<string, unknown>).proofValue).toMatch(/^z/);
  });
});

describe('signCredentialWithExternalSigner — error propagation [VC-003]', () => {
  test('propagates a rejection from signBytes()', async () => {
    const manager = makeManager();
    const failing: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkTestKey#z6MkTestKey',
      sign: async () => ({ proofValue: '' }),
      signBytes: async () => {
        throw new Error('HSM unavailable');
      },
    };

    await expect(
      manager.signCredentialWithExternalSigner(vcFor('did:key:z6MkTestKey#z6MkTestKey'), failing)
    ).rejects.toThrow('HSM unavailable');
  });

  test('propagates the original error type (not wrapped)', async () => {
    const manager = makeManager();

    class CustomSignerError extends Error {
      constructor(public code: number, msg: string) {
        super(msg);
        this.name = 'CustomSignerError';
      }
    }

    const failing: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkOther#z6MkOther',
      sign: async () => ({ proofValue: '' }),
      signBytes: async () => {
        throw new CustomSignerError(503, 'Signer service timeout');
      },
    };

    const rejection = manager.signCredentialWithExternalSigner(
      vcFor('did:key:z6MkOther#z6MkOther'), failing);
    await expect(rejection).rejects.toBeInstanceOf(CustomSignerError);
    await expect(rejection).rejects.toThrow('Signer service timeout');
  });

  test('propagates a rejected promise from signBytes()', async () => {
    const manager = makeManager();
    const failing: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkReject#z6MkReject',
      sign: async () => ({ proofValue: '' }),
      signBytes: () => Promise.reject(new Error('Network error from KMS')),
    };

    await expect(
      manager.signCredentialWithExternalSigner(vcFor('did:key:z6MkReject#z6MkReject'), failing)
    ).rejects.toThrow('Network error from KMS');
  });

  test('propagates an async-delayed rejection', async () => {
    const manager = makeManager();
    const failing: ExternalSigner = {
      getVerificationMethodId: () => 'did:key:z6MkDelayed#z6MkDelayed',
      sign: async () => ({ proofValue: '' }),
      signBytes: () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Delayed HSM failure')), 10);
        }),
    };

    await expect(
      manager.signCredentialWithExternalSigner(vcFor('did:key:z6MkDelayed#z6MkDelayed'), failing)
    ).rejects.toThrow('Delayed HSM failure');
  });
});

describe('DIDManager is required [plan 037]', () => {
  test('constructing without one throws instead of silently failing DI proofs later', () => {
    expect(() => new CredentialManager(defaultConfig, undefined as never)).toThrow(
      /requires a DIDManager/
    );
  });

  test('the error explains the consequence, not just the missing argument', () => {
    let err: unknown;
    try {
      new CredentialManager(defaultConfig, undefined as never);
    } catch (e) {
      err = e;
    }
    expect((err as { code: string }).code).toBe('DID_MANAGER_REQUIRED');
    expect((err as Error).message).toContain('neither be issued nor verified');
  });
});
