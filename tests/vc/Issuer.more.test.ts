import { Issuer } from '../../src/vc/Issuer';
import { DIDManager } from '../../src/did/DIDManager';

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
});

