/**
 * Issue #591 — BBS+ selective disclosure is parked.
 *
 * The finding: a holder derived a bbs-2023 proof that revealed only type and
 * subject, hiding `validUntil` (already expired) and `credentialStatus`. The
 * verifier saw no validity or status fields, treated that as "no policy", and
 * returned `verified: true`. The suite is disabled rather than patched, so the
 * regression here is the strongest form: a bbs-2023 proof of ANY shape fails
 * closed before key resolution, and nothing in the SDK can produce one.
 */
import { describe, test, expect } from 'bun:test';
import * as SDK from '../../src';
import { Verifier } from '../../src/vc/Verifier';
import { CredentialManager } from '../../src/vc/CredentialManager';
import { DIDManager } from '../../src/did/DIDManager';
import { DataIntegrityProofManager } from '../../src/vc/proofs/data-integrity';
import type { VerifiableCredential } from '../../src/types';
import sdkPackage from '../../package.json';

const didManager = new DIDManager({} as never);

// The exact presentation from the audit: an expired, status-bearing credential
// whose derived proof reveals only type, issuer, and subject. Nothing here is
// cryptographically valid — it must not need to be, because the suite is
// rejected on name alone.
const derivedPresentation: VerifiableCredential = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'OriginalsResourceCredential'],
  issuer: 'did:key:issuer',
  credentialSubject: { id: 'did:key:subject' },
  proof: {
    type: 'DataIntegrityProof',
    cryptosuite: 'bbs-2023',
    verificationMethod: 'did:key:issuer#bbs-1',
    proofPurpose: 'assertionMethod',
    created: '2024-01-01T00:00:00Z',
    proofValue: 'u' + 'A'.repeat(64),
  },
} as unknown as VerifiableCredential;

describe('bbs-2023 is disabled (#591)', () => {
  test('a derived proof that hid expiry and status never verifies', async () => {
    const res = await new Verifier(didManager).verifyCredential(derivedPresentation);
    expect(res.verified).toBe(false);
    expect(res.errors?.join('\n')).toContain('Cryptosuite bbs-2023 is disabled');
  });

  test('the same presentation is rejected by CredentialManager.verifyCredential', async () => {
    const cm = new CredentialManager({ network: 'regtest', defaultKeyType: 'Ed25519' }, didManager);
    expect(await cm.verifyCredential(derivedPresentation)).toBe(false);
  });

  test('a bbs-2023 base proof is rejected before any key resolution', async () => {
    let loaderCalls = 0;
    const res = await DataIntegrityProofManager.verifyProof(
      { ...derivedPresentation, validUntil: '2000-01-01T00:00:00Z' },
      derivedPresentation.proof as never,
      { documentLoader: async () => { loaderCalls += 1; throw new Error('must not be reached'); } }
    );
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('bbs-2023 is disabled');
    expect(loaderCalls).toBe(0);
  });

  test('nothing in the SDK can issue a bbs-2023 proof', async () => {
    await expect(
      DataIntegrityProofManager.createProof(derivedPresentation, {
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: 'did:key:issuer#bbs-1',
        proofPurpose: 'assertionMethod',
        privateKey: new Uint8Array(32),
      })
    ).rejects.toThrow('Cryptosuite bbs-2023 is disabled');
  });

  test('the BBS surface is gone from the root export and CredentialManager', () => {
    const exported = SDK as unknown as Record<string, unknown>;
    for (const name of ['BBSCryptosuiteManager', 'BBSCryptosuiteUtils', 'BbsSimple']) {
      expect(exported[name]).toBeUndefined();
    }
    const proto = CredentialManager.prototype as unknown as Record<string, unknown>;
    expect(proto.prepareSelectiveDisclosure).toBeUndefined();
    expect(proto.deriveSelectiveProof).toBeUndefined();
    // Still a plain JSON Pointer utility, unrelated to disclosure.
    expect(typeof proto.getFieldByPointer).toBe('function');
  });

  test('the BBS signature backend is no longer a dependency', () => {
    const deps = {
      ...(sdkPackage as { dependencies?: Record<string, string> }).dependencies,
      ...(sdkPackage as { devDependencies?: Record<string, string> }).devDependencies,
    };
    expect(Object.keys(deps).filter((d) => /bbs/i.test(d))).toEqual([]);
  });
});
