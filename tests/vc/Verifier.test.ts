import { Verifier } from '../../src/vc/Verifier';
import { Issuer } from '../../src/vc/Issuer';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { registerVerificationMethod } from '../../src/vc/documentLoader';
import { DIDManager } from '../../src/did/DIDManager';

describe('diwings Verifier', () => {
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
  registerVerificationMethod(vm);

  test('verifies a credential (v2)', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject1' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(true);
  });

  test('verifies a presentation (v2) with nested credential', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Nested'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject2' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: [vc]
      } as any,
      { proofPurpose: 'authentication' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyPresentation(vp);
    expect(res.verified).toBe(true);
  });

  test('fails when proof missing', async () => {
    const verifier = new Verifier(didManager);
    const badVc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential']
    };
    const res = await verifier.verifyCredential(badVc);
    expect(res.verified).toBe(false);
  });
});

