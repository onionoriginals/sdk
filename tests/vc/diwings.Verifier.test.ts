import { Verifier } from '../../src/vc/diwings/Verifier';
import { Issuer } from '../../src/vc/diwings/Issuer';
import { DIDManager } from '../../src/did/DIDManager';

describe('diwings Verifier', () => {
  const didManager = new DIDManager({} as any);
  const did = 'did:peer:issuer1';
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: 'z6MkiPublicFake',
    secretKeyMultibase: 'z6MkiSecretFake'
  };

  test('verifies a credential (v1)', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject1' }
      } as any,
      { contextVersion: 'v1', proofPurpose: 'assertionMethod' }
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
      { contextVersion: 'v2', proofPurpose: 'assertionMethod' }
    );
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: [vc]
      } as any,
      { contextVersion: 'v2', proofPurpose: 'authentication' }
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

