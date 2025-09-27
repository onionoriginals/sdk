import { CredentialManager } from '../../src/vc/CredentialManager';
import { DIDManager } from '../../src/did/DIDManager';

describe('CredentialManager verify with didManager present but legacy path', () => {
  test('verifyCredential returns false when legacy proof invalid and didManager present', async () => {
    const dm = new DIDManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any);
    const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any, dm);
    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:ex',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {},
      proof: { type: 'DataIntegrityProof', created: new Date().toISOString(), verificationMethod: 'z' + Buffer.from('bad').toString('base64url'), proofPurpose: 'assertionMethod', proofValue: 'z' + Buffer.from('bad').toString('base64url') }
    };
    const ok = await cm.verifyCredential(vc);
    expect(ok).toBe(false);
  });
});

