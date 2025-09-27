import { CredentialManager } from '../../src/vc/CredentialManager';
import { DIDManager } from '../../src/did/DIDManager';
import { registerVerificationMethod } from '../../src/vc/documentLoader';
import { multikey } from '../../src/crypto/Multikey';

describe('CredentialManager DID path with VM missing type defaults to Multikey', () => {
  test('uses default type when document.type is absent', async () => {
    const dm = new DIDManager({ network: 'mainnet', defaultKeyType: 'Ed25519' } as any);
    const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'Ed25519' } as any, dm);
    const sk = new Uint8Array(32).fill(5);
    const pk = new Uint8Array(32).fill(7);
    const pkMb = multikey.encodePublicKey(pk, 'Ed25519');
    const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
    // Register VM without type so code path uses document.type || 'Multikey'
    registerVerificationMethod({ id: 'did:ex:vm#3', controller: 'did:ex', publicKeyMultibase: pkMb } as any);
    const vc: any = { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:ex', issuanceDate: new Date().toISOString(), credentialSubject: {} };
    const signed = await cm.signCredential(vc, skMb, 'did:ex:vm#3');
    expect(signed.proof).toBeDefined();
  });
});

