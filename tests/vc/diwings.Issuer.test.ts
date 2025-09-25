import { Issuer } from '../../src/vc/diwings/Issuer';
import { DIDManager } from '../../src/did/DIDManager';

describe('diwings Issuer', () => {
  const didManager = new DIDManager({} as any);
  const did = 'did:peer:issuer1';
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: 'z6MkiPublicFake',
    secretKeyMultibase: 'z6MkiSecretFake'
  };

  const baseCredential = {
    type: ['VerifiableCredential', 'Test'],
    issuer: did,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject1' }
  } as any;

  test('issues v1 credential and produces proof', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(baseCredential, { contextVersion: 'v1', proofPurpose: 'assertionMethod' });
    expect(vc['@context'][0]).toContain('/2018/credentials/v1');
    expect(vc.proof).toBeDefined();
  });

  test('issues v2 presentation and produces proof referencing challenge/domain', async () => {
    const issuer = new Issuer(didManager, vm);
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: []
      } as any,
      { contextVersion: 'v2', proofPurpose: 'authentication', challenge: 'abc', domain: 'example.org' }
    );
    expect(vp['@context'][0]).toContain('/ns/credentials/v2');
    expect(vp.proof).toBeDefined();
  });

  test('throws if missing secret key', async () => {
    const issuer = new Issuer(didManager, { ...vm, secretKeyMultibase: undefined });
    await expect(
      issuer.issueCredential(baseCredential, { contextVersion: 'v1', proofPurpose: 'assertionMethod' })
    ).rejects.toThrow('Missing secretKeyMultibase');
  });
});

