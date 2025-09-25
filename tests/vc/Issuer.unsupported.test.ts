import { Issuer } from '../../src/vc/Issuer';
import { DIDManager } from '../../src/did/DIDManager';
import { multikey } from '../../src/crypto/Multikey';

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

