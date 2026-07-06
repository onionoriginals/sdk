import { describe, test, expect } from 'bun:test';
import { CredentialManager } from '../../src/vc/CredentialManager';
import { DIDManager } from '../../src/did/DIDManager';
import { computeCredentialDigest } from '../../src/utils/credential-digest';
import { encodeBase64UrlMultibase } from '../../src/utils/encoding';
import { signerForKeyType } from '../../src/crypto/Signer';
import { multikey } from '../../src/crypto/Multikey';
import * as ed25519 from '@noble/ed25519';
import type { VerifiableCredential, Proof } from '../../src/types';

/**
 * Regression tests: legacy (non-cryptosuite) verification must reject
 * revoked/compromised verification methods.
 *
 * Attack (pre-fix): an attacker holding a rotated-out or compromised key mints
 * a FRESH legacy-format proof (no `cryptosuite` member, so verifyCredential
 * takes the legacy branch), signs the legacy digest with the old key, and
 * verifyCredential returned true even though the DID document marks that
 * verification method `revoked`/`compromised`. Two bugs compounded:
 *
 *   1. resolveVerificationMethodMultibase first calls the retirement-aware
 *      document loader; when the loader THREW to refuse the retired key, the
 *      catch swallowed the refusal and fell through to resolveDID.
 *   2. The resolveDID fallback returned publicKeyMultibase from the DID
 *      document without ever checking the VM's `revoked`/`compromised`
 *      markers.
 *
 * Both paths must fail closed, mirroring assertNotRetired on the Data
 * Integrity path (documentLoader.ts).
 */

const config = { network: 'regtest', defaultKeyType: 'Ed25519', enableLogging: false } as any;

const issuerDid = 'did:webvh:example.com:issuer';
const vmId = `${issuerDid}#keys-1`;

// Deterministic Ed25519 keypair (the "old", rotated-out key the attacker holds).
const sk = new Uint8Array(32).map((_, i) => (i + 7) & 0xff);
const pk = ed25519.getPublicKey(sk);
const publicKeyMultibase = multikey.encodePublicKey(pk, 'Ed25519');
const secretKeyMultibase = multikey.encodePrivateKey(sk, 'Ed25519');

function makeCredential(): VerifiableCredential {
  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://originals.build/context'
    ],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer: issuerDid,
    validFrom: '2026-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:peer:subject1',
      resourceId: 'resource-123',
      contentHash: 'deadbeefcafe'
    }
  } as any;
}

/**
 * Mint a fresh legacy-format proof exactly the way an attacker with the old
 * private key would: legacy digest, no `cryptosuite` member.
 */
async function mintLegacyProof(credential: VerifiableCredential): Promise<Proof> {
  const proofBase: Proof = {
    type: 'DataIntegrityProof',
    created: new Date('2026-01-02T00:00:00Z').toISOString(),
    verificationMethod: vmId,
    proofPurpose: 'assertionMethod',
    proofValue: ''
  };
  const digest = await computeCredentialDigest(
    credential as unknown as Record<string, unknown>,
    proofBase as unknown as Record<string, unknown>
  );
  const signer = signerForKeyType('Ed25519');
  const sig = await signer.sign(Buffer.from(digest), secretKeyMultibase);
  return { ...proofBase, proofValue: encodeBase64UrlMultibase(sig) };
}

function makeDidManager(vmExtra: Record<string, unknown>): DIDManager {
  const didManager = new DIDManager(config);
  (didManager as any).resolveDID = async (did: string) => {
    if (did !== issuerDid) return null;
    return {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: issuerDid,
      verificationMethod: [
        {
          id: vmId,
          type: 'Multikey',
          controller: issuerDid,
          publicKeyMultibase,
          ...vmExtra
        }
      ]
    };
  };
  return didManager;
}

describe('legacy verification path must reject retired keys', () => {
  test('control: fresh legacy proof by a NON-retired key verifies (test harness is valid)', async () => {
    const cm = new CredentialManager(config, makeDidManager({}));
    const credential = makeCredential();
    const signed = { ...credential, proof: await mintLegacyProof(credential) };
    expect(await cm.verifyCredential(signed)).toBe(true);
  });

  test('BLOCKER repro: fresh legacy proof signed by a REVOKED key must NOT verify', async () => {
    const cm = new CredentialManager(
      config,
      makeDidManager({ revoked: '2026-01-01T00:00:00Z' })
    );
    const credential = makeCredential();
    const signed = { ...credential, proof: await mintLegacyProof(credential) };
    expect(await cm.verifyCredential(signed)).toBe(false);
  });

  test('fresh legacy proof signed by a COMPROMISED key must NOT verify', async () => {
    const cm = new CredentialManager(
      config,
      makeDidManager({ compromised: '2026-01-01T00:00:00Z' })
    );
    const credential = makeCredential();
    const signed = { ...credential, proof: await mintLegacyProof(credential) };
    expect(await cm.verifyCredential(signed)).toBe(false);
  });

  test('resolveDID fallback rejects a revoked VM even when the document loader failed for an unrelated reason', async () => {
    // First resolveDID call (inside the document loader) fails with a
    // non-retirement error, forcing resolveVerificationMethodMultibase onto
    // its resolveDID fallback branch; the second call returns the DID doc
    // with the VM marked revoked. The fallback's own retirement check must
    // reject the key.
    const didManager = new DIDManager(config);
    let calls = 0;
    (didManager as any).resolveDID = async (did: string) => {
      calls += 1;
      if (calls === 1) throw new Error('transient resolver failure');
      if (did !== issuerDid) return null;
      return {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: issuerDid,
        verificationMethod: [
          {
            id: vmId,
            type: 'Multikey',
            controller: issuerDid,
            publicKeyMultibase,
            revoked: '2026-01-01T00:00:00Z'
          }
        ]
      };
    };
    const cm = new CredentialManager(config, didManager);

    const resolved = await (cm as any).resolveVerificationMethodMultibase(vmId, issuerDid);
    expect(resolved).toBeNull();
  });

  test('valid key still verifies when the loader fails with a benign error that merely mentions "revoked"', async () => {
    // Regression (#320 review): isRetirementRefusal matched ANY error message
    // containing "retired|revoked|compromised", so a benign resolver/TLS
    // failure like "TLS certificate revoked" was misclassified as a
    // retirement refusal and a VALID legacy credential failed to verify.
    // Only the loader's exact retirement message
    // ("Verification method is retired (revoked or compromised): <didUrl>")
    // may fail closed; other errors must fall through to the resolveDID
    // fallback, which here resolves the valid, non-retired key.
    const didManager = new DIDManager(config);
    let calls = 0;
    (didManager as any).resolveDID = async (did: string) => {
      calls += 1;
      // First call happens inside the document loader: fail with a benign
      // error whose text contains the word "revoked".
      if (calls === 1) throw new Error('TLS certificate revoked while fetching DID document');
      if (did !== issuerDid) return null;
      return {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: issuerDid,
        verificationMethod: [
          {
            id: vmId,
            type: 'Multikey',
            controller: issuerDid,
            publicKeyMultibase
          }
        ]
      };
    };
    const cm = new CredentialManager(config, didManager);
    const credential = makeCredential();
    const signed = { ...credential, proof: await mintLegacyProof(credential) };
    expect(await cm.verifyCredential(signed)).toBe(true);
  });

  test('resolveVerificationMethodMultibase returns null for a revoked VM (direct unit check)', async () => {
    const cm = new CredentialManager(
      config,
      makeDidManager({ revoked: '2026-01-01T00:00:00Z' })
    );
    const resolved = await (cm as any).resolveVerificationMethodMultibase(vmId, issuerDid);
    expect(resolved).toBeNull();
  });
});
