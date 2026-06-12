import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { UnifiedVerifier, classifyDocument } from '../../../src/verify/UnifiedVerifier';
import { Issuer } from '../../../src/vc/Issuer';
import { multikey } from '../../../src/crypto/Multikey';
import { registerVerificationMethod, verificationMethodRegistry } from '../../../src/vc/documentLoader';
import { DIDManager } from '../../../src/did/DIDManager';

// SPIKE test — proves the unified dispatch works for two proof types and that
// the credential branch inherits the issuer-bound Verifier (plan 001), i.e. a
// tampered credential fails.
describe('UnifiedVerifier (spike)', () => {
  const didManager = new DIDManager({} as any);
  const did = 'did:peer:issuer-unified';
  const sk = new Uint8Array(32).map((_, i) => (i + 7) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519'),
  };

  beforeEach(() => {
    registerVerificationMethod(vm);
  });

  afterEach(() => {
    verificationMethodRegistry.clear();
  });

  test('classifyDocument routes by shape', () => {
    expect(classifyDocument({ type: ['VerifiableCredential'] })).toBe('credential');
    expect(classifyDocument({ events: [] })).toBe('eventLog');
    expect(classifyDocument({ foo: 'bar' })).toBe('unknown');
  });

  test('routes a valid credential to the issuer-bound verifier and returns verified', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject-unified' },
      } as any,
      { proofPurpose: 'assertionMethod' }
    );

    const unified = new UnifiedVerifier(didManager);
    const res = await unified.verify(vc);
    expect(res.kind).toBe('credential');
    expect(res.verified).toBe(true);
  });

  test('a tampered credential is NOT verified (inherits the real verifier, not a stub)', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc: any = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject-unified' },
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    // Tamper with the subject after signing.
    vc.credentialSubject.id = 'did:peer:attacker';

    const unified = new UnifiedVerifier(didManager);
    const res = await unified.verify(vc);
    expect(res.kind).toBe('credential');
    expect(res.verified).toBe(false);
  });

  test('routes an event-log document to the CEL verifier', async () => {
    const unified = new UnifiedVerifier(didManager);
    // A structurally-minimal event log: routing is what we assert here, not
    // signature validity.
    const res = await unified.verify({ events: [] } as any);
    expect(res.kind).toBe('eventLog');
    expect(typeof res.verified).toBe('boolean');
  });

  test('an unclassifiable document returns unknown / not verified', async () => {
    const unified = new UnifiedVerifier(didManager);
    const res = await unified.verify({ hello: 'world' });
    expect(res.kind).toBe('unknown');
    expect(res.verified).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
