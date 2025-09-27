import { CredentialManager } from '../../src/vc/CredentialManager';
import { DIDManager } from '../../src/did/DIDManager';
import { registerVerificationMethod } from '../../src/vc/documentLoader';
import * as secp256k1 from '@noble/secp256k1';

describe('CredentialManager with didManager provided falls back to local signer when VM incomplete', () => {
  test('covers didManager gate with fallback path', async () => {
    const dm = new DIDManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any);
    const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any, dm);
    // Register VM without publicKeyMultibase so DID path cannot proceed and will fall back
    registerVerificationMethod({ id: 'did:ex:vm#fallback', controller: 'did:ex' } as any);

    const sk = secp256k1.utils.randomPrivateKey();
    const skMb = 'z' + Buffer.from(sk).toString('base64url');

    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:ex',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {}
    };

    const signed = await cm.signCredential(vc, skMb, 'did:ex:vm#fallback');
    expect(signed.proof).toBeDefined();
  });
});