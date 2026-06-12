import { describe, test, expect, beforeEach } from 'bun:test';
import { CredentialManager } from '../../src/vc/CredentialManager';
import { DIDManager } from '../../src/did/DIDManager';
import { registerVerificationMethod } from '../../src/vc/documentLoader';
import { multikey } from '../../src/crypto/Multikey';
import * as ed25519 from '@noble/ed25519';
import type { VerifiableCredential } from '../../src/types';

/**
 * Regression tests for GitHub issue #167:
 * Data Integrity signatures must cover ALL credential fields.
 *
 * Previously, stub JSON-LD contexts plus `safe: false` canonicalization
 * meant undefined terms were silently dropped from the signed RDF dataset,
 * so tampering with credentialSubject (and most other fields) did not
 * invalidate the proof.
 */

const config = { network: 'regtest', defaultKeyType: 'Ed25519', enableLogging: false } as any;

describe('credential tamper resistance (issue #167)', () => {
  const didManager = new DIDManager(config);
  const did = 'did:peer:issuer1';
  const sk = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
  };

  beforeEach(() => {
    registerVerificationMethod(vm);
  });

  const makeCredential = (): VerifiableCredential => ({
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://originals.build/context'
    ],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer: did,
    validFrom: '2026-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:peer:subject1',
      resourceId: 'resource-123',
      contentHash: 'deadbeefcafe'
    }
  } as any);

  test('untampered credential verifies', async () => {
    const cm = new CredentialManager(config, didManager);
    const signed = await cm.signCredential(makeCredential(), vm.secretKeyMultibase, vm.id);
    expect(await cm.verifyCredential(signed)).toBe(true);
  });

  test('tampering credentialSubject invalidates the proof', async () => {
    const cm = new CredentialManager(config, didManager);
    const signed = await cm.signCredential(makeCredential(), vm.secretKeyMultibase, vm.id);
    (signed.credentialSubject as any).contentHash = 'tampered';
    expect(await cm.verifyCredential(signed)).toBe(false);
  });

  test('adding a field to credentialSubject invalidates the proof', async () => {
    const cm = new CredentialManager(config, didManager);
    const signed = await cm.signCredential(makeCredential(), vm.secretKeyMultibase, vm.id);
    (signed.credentialSubject as any).resources = 'injected-claim';
    expect(await cm.verifyCredential(signed)).toBe(false);
  });

  test('tampering validFrom invalidates the proof', async () => {
    const cm = new CredentialManager(config, didManager);
    const signed = await cm.signCredential(makeCredential(), vm.secretKeyMultibase, vm.id);
    (signed as any).validFrom = '2030-01-01T00:00:00Z';
    expect(await cm.verifyCredential(signed)).toBe(false);
  });

  test('issuer-supplied @context is preserved on the signed credential', async () => {
    const cm = new CredentialManager(config, didManager);
    const signed = await cm.signCredential(makeCredential(), vm.secretKeyMultibase, vm.id);
    expect(signed['@context']).toContain('https://originals.build/context');
    expect(signed['@context']).toContain('https://www.w3.org/ns/credentials/v2');
  });

  test('proofValue is multibase base58btc (z-prefixed)', async () => {
    const cm = new CredentialManager(config, didManager);
    const signed = await cm.signCredential(makeCredential(), vm.secretKeyMultibase, vm.id);
    const proof = signed.proof as any;
    expect(proof.proofValue.startsWith('z')).toBe(true);
  });

  test('signing a credential with terms undefined in its context throws', async () => {
    const cm = new CredentialManager(config, didManager);
    const cred = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential'],
      issuer: did,
      validFrom: '2026-01-01T00:00:00Z',
      credentialSubject: {
        id: 'did:peer:subject1',
        someUndefinedTerm: 'not in any context'
      }
    } as any;
    await expect(
      cm.signCredential(cred, vm.secretKeyMultibase, vm.id)
    ).rejects.toThrow();
  });

  test('legacy signer path rejects undefined terms instead of silently dropping them', async () => {
    // Without a DIDManager the fallback local signer is used; it must not
    // sign a dataset from which unknown fields were silently excluded.
    const cm = new CredentialManager(config);
    const cred = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer1',
      issuanceDate: '2026-01-01T00:00:00Z',
      credentialSubject: {
        id: 'did:peer:subject1',
        someUndefinedTerm: 'dropped silently before the fix'
      }
    } as any;
    await expect(
      cm.signCredential(cred, vm.secretKeyMultibase, vm.publicKeyMultibase)
    ).rejects.toThrow();
  });

  test('factory-created credentials are signable and tamper-evident', async () => {
    const cm = new CredentialManager(config, didManager);
    const unsigned = cm.issueResourceCredential(
      {
        id: 'res-1',
        type: 'text',
        hash: 'abc123',
        contentType: 'text/plain',
        createdAt: '2026-01-01T00:00:00Z'
      } as any,
      'did:peer:asset1',
      did
    );
    const signed = await cm.signCredential(unsigned, vm.secretKeyMultibase, vm.id);
    expect(await cm.verifyCredential(signed)).toBe(true);
    (signed.credentialSubject as any).contentHash = 'tampered';
    expect(await cm.verifyCredential(signed)).toBe(false);
  });
});
