import { CredentialManager } from '../../src/vc/CredentialManager';

describe('CredentialManager.getSigner default case when config keyType undefined', () => {
  test('defaults to ES256K', async () => {
    const cm = new CredentialManager({ network: 'mainnet' } as any);
    const vc: any = { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:ex', issuanceDate: new Date().toISOString(), credentialSubject: {} };
    const sk = new Uint8Array(32).fill(3);
    const pk = new Uint8Array(33).fill(2);
    const signed = await cm.signCredential(vc, 'z' + Buffer.from(sk).toString('base64url'), 'z' + Buffer.from(pk).toString('base64url'));
    expect(signed.proof).toBeDefined();
  });
});

