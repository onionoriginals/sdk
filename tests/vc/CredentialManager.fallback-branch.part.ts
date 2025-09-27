import { CredentialManager } from '../../src/vc/CredentialManager';
import { DIDManager } from '../../src/did/DIDManager';
import { registerVerificationMethod } from '../../src/vc/documentLoader';

describe('CredentialManager DID path fallback when VM doc lacks type', () => {
  test('falls back to legacy signing if DID loader returns VM missing fields', async () => {
    const dm = new DIDManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any);
    const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any, dm);
    // Register minimal VM without type/publicKeyMultibase so DID path cannot proceed to Issuer
    registerVerificationMethod({ id: 'did:ex:vm#x', controller: 'did:ex' } as any);
    const sk = new Uint8Array(32).fill(1);
    const pk = new Uint8Array(33).fill(2);
    const vc: any = { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:ex', issuanceDate: new Date().toISOString(), credentialSubject: {} };
    const signed = await cm.signCredential(vc, 'z' + Buffer.from(sk).toString('base64url'), 'did:ex:vm#x');
    expect(signed.proof).toBeDefined();
  });
});

