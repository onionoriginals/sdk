import { CredentialManager } from '../../src/vc/CredentialManager';
import { VerifiableCredential } from '../../src/types';
import * as secp256k1 from '@noble/secp256k1';

describe('CredentialManager local verify path without didManager', () => {
  test('signs and verifies locally when didManager is undefined', async () => {
    const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any);
    const baseVC: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:ex',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {}
    } as any;
    const sk = secp256k1.utils.randomPrivateKey();
    const pk = secp256k1.getPublicKey(sk, true);
    const skMb = 'z' + Buffer.from(sk).toString('base64url');
    const pkMb = 'z' + Buffer.from(pk).toString('base64url');
    const signed = await cm.signCredential(baseVC, skMb, pkMb);
    const ok = await cm.verifyCredential(signed);
    expect(ok).toBe(true);
  });
});

