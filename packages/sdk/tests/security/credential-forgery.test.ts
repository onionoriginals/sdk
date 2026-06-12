import { test, expect } from 'bun:test';
import { CredentialManager } from '../../src/vc/CredentialManager';
import { multikey } from '../../src/crypto/Multikey';
import * as secp from '@noble/secp256k1';

test('forged credential signed with an unrelated key does NOT verify', async () => {
  const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any);

  // Attacker's own key — unrelated to the victim issuer DID
  const attackerSk = secp.utils.randomPrivateKey();
  const attackerPk = secp.getPublicKey(attackerSk, true);
  const attackerSkMb = multikey.encodePrivateKey(attackerSk, 'Secp256k1');
  const attackerPkMb = multikey.encodePublicKey(attackerPk, 'Secp256k1');

  const forged: any = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:webvh:victim.example.com:trusted-authority',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:attacker', role: 'admin' }
  };

  // Attacker signs with their own key and embeds their own public key in the proof
  const signed = await cm.signCredential(forged, attackerSkMb, attackerPkMb);
  delete (signed.proof as any).cryptosuite; // force the legacy path

  // Before this plan, this returned true (forgery). It must now be false.
  expect(await cm.verifyCredential(signed)).toBe(false);
});

test('embedded publicKeyMultibase in the proof is never trusted', async () => {
  const cm = new CredentialManager({ network: 'mainnet', defaultKeyType: 'ES256K' } as any);
  const sk = secp.utils.randomPrivateKey();
  const pk = secp.getPublicKey(sk, true);
  const skMb = multikey.encodePrivateKey(sk, 'Secp256k1');
  const pkMb = multikey.encodePublicKey(pk, 'Secp256k1');

  const cred: any = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:victim',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject' }
  };
  const signed: any = await cm.signCredential(cred, skMb, pkMb);
  (signed.proof as any).publicKeyMultibase = pkMb; // attacker pins their own key
  delete (signed.proof as any).cryptosuite;
  expect(await cm.verifyCredential(signed)).toBe(false);
});
