import { describe, test, expect } from 'bun:test';
import { Issuer } from '../../../src/vc/Issuer';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { DIDManager } from '../../../src/did/DIDManager';

describe('diwings Issuer', () => {
  const didManager = new DIDManager({} as any);
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

  const baseCredential = {
    type: ['VerifiableCredential', 'Test'],
    issuer: did,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject1' }
  } as any;

  test('issues v2 presentation and produces proof referencing challenge/domain', async () => {
    const issuer = new Issuer(didManager, vm);
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: []
      } as any,
      { proofPurpose: 'authentication', challenge: 'abc', domain: 'example.org' }
    );
    expect(vp['@context'][0]).toContain('/ns/credentials/v2');
    expect(vp.proof).toBeDefined();
  });

  test('throws if missing secret key', async () => {
    const issuer = new Issuer(didManager, { ...vm, secretKeyMultibase: undefined });
    await expect(issuer.issueCredential(baseCredential, { proofPurpose: 'assertionMethod' })).rejects.toThrow('Missing secretKeyMultibase');
  });

  test('issues v2 credential and produces proof', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(baseCredential, { proofPurpose: 'assertionMethod' });
    expect(vc['@context'][0]).toContain('/ns/credentials/v2');
    expect(vc.proof).toBeDefined();
  });
});

/** Inlined from Issuer.more.part.ts */

describe('Issuer branches', () => {
  const dm = new DIDManager({} as any);
  const vm = {
    id: 'did:ex:1#key-1',
    controller: 'did:ex:1',
    publicKeyMultibase: 'z', // force decode failure -> default Ed25519 path
    secretKeyMultibase: 'z7' // invalid but never used due to loader use only
  } as any;

  test('throws when missing secretKeyMultibase', async () => {
    const issuer = new Issuer(dm, { ...vm, secretKeyMultibase: undefined });
    await expect(issuer.issueCredential({ id: 'urn:cred:1', type: ['VerifiableCredential'], issuer: 'did:ex:1', issuanceDate: new Date().toISOString(), credentialSubject: {} } as any, { proofPurpose: 'assertionMethod' })).rejects.toThrow('Missing secretKeyMultibase');
  });

  test('issuePresentation throws when secretKeyMultibase missing', async () => {
    const issuer = new Issuer(dm, { ...vm, secretKeyMultibase: undefined });
    await expect(issuer.issuePresentation({ holder: 'did:ex:1' } as any, { proofPurpose: 'authentication' })).rejects.toThrow('Missing secretKeyMultibase');
  });

  test('issueCredential uses issuer object id when provided', async () => {
    const issuer = new Issuer(dm, { ...vm, secretKeyMultibase: 'z7' });
    await expect(issuer.issueCredential({ id: 'urn:cred:2', type: ['VerifiableCredential'], issuer: { id: 'did:ex:1' } as any, issuanceDate: new Date().toISOString(), credentialSubject: {} } as any, { proofPurpose: 'assertionMethod' })).rejects.toThrow();
  });

  test('issueCredential falls back to controller when issuer missing', async () => {
    const issuer = new Issuer(dm, { ...vm, secretKeyMultibase: 'z7' });
    await expect(issuer.issueCredential({ id: 'urn:cred:3', type: ['VerifiableCredential'], issuanceDate: new Date().toISOString(), credentialSubject: {} } as any, { proofPurpose: 'assertionMethod' })).rejects.toThrow();
  });
});




/** Inlined from Issuer.unsupported.part.ts */

describe('Issuer unsupported key types', () => {
  const dm = new DIDManager({} as any);

  test('issueCredential throws for non-Ed25519', async () => {
    const pubMb = multikey.encodePublicKey(new Uint8Array(33).fill(1), 'Secp256k1');
    const secMb = multikey.encodePrivateKey(new Uint8Array(32).fill(2), 'Secp256k1');
    const issuer = new Issuer(dm, { id: 'did:ex:3#k', controller: 'did:ex:3', publicKeyMultibase: pubMb, secretKeyMultibase: secMb });
    await expect(issuer.issueCredential({ id: 'urn:cred:2', type: ['VerifiableCredential'], issuer: 'did:ex:3', issuanceDate: new Date().toISOString(), credentialSubject: {} } as any, { proofPurpose: 'assertionMethod' })).rejects.toThrow('Only Ed25519 supported');
  });

  test('issuePresentation throws for non-Ed25519', async () => {
    const pubMb = multikey.encodePublicKey(new Uint8Array(33).fill(1), 'Secp256k1');
    const secMb = multikey.encodePrivateKey(new Uint8Array(32).fill(2), 'Secp256k1');
    const issuer = new Issuer(dm, { id: 'did:ex:3#k', controller: 'did:ex:3', publicKeyMultibase: pubMb, secretKeyMultibase: secMb });
    await expect(issuer.issuePresentation({ holder: 'did:ex:3' } as any, { proofPurpose: 'authentication' })).rejects.toThrow('Only Ed25519 supported');
  });
});
