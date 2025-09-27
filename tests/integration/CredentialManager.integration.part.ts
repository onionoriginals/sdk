import { OriginalsSDK } from '../../src';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { registerVerificationMethod } from '../../src/vc/documentLoader';

describe('Integration: CredentialManager issue/verify roundtrip', () => {
  const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });

  test('issue and verify using Issuer/Verifier wiring', async () => {
    const did = 'did:peer:issuer1';
    const sk = ed25519.utils.randomPrivateKey();
    const pk = await (ed25519 as any).getPublicKeyAsync(sk);
    const secretKeyMultibase = multikey.encodePrivateKey(sk, 'Ed25519');
    const publicKeyMultibase = multikey.encodePublicKey(pk, 'Ed25519');
    const vm = `${did}#keys-1`;
    registerVerificationMethod({ id: vm, controller: did, type: 'Multikey', publicKeyMultibase });

    const base = {
      type: ['VerifiableCredential', 'Test'],
      issuer: did,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject1' }
    } as any;

    const signed = await sdk.credentials.signCredential(base, secretKeyMultibase, vm);
    expect(signed.proof).toBeDefined();
    const verified = await sdk.credentials.verifyCredential(signed);
    expect(verified).toBe(true);
  });
});

