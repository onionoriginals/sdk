import { Issuer } from '../../src/vc/Issuer';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { DIDManager } from '../../src/did/DIDManager';

describe('diwings Issuer', () => {
  const didManager = new DIDManager({} as any);
  const did = 'did:peer:issuer1';
  const sk = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
  };

  const baseCredential = {
    type: ['VerifiableCredential', 'Test'],
    issuer: did,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject1' }
  } as any;

  test('issues v2 presentation and produces proof referencing challenge/domain', async () => {
    const issuer = new Issuer(didManager, vm);
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: []
      } as any,
      { proofPurpose: 'authentication', challenge: 'abc', domain: 'example.org' }
    );
    expect(vp['@context'][0]).toContain('/ns/credentials/v2');
    expect(vp.proof).toBeDefined();
  });

  test('throws if missing secret key', async () => {
    const issuer = new Issuer(didManager, { ...vm, secretKeyMultibase: undefined });
    await expect(issuer.issueCredential(baseCredential, { proofPurpose: 'assertionMethod' })).rejects.toThrow('Missing secretKeyMultibase');
  });

  test('issues v2 credential and produces proof', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(baseCredential, { proofPurpose: 'assertionMethod' });
    expect(vc['@context'][0]).toContain('/ns/credentials/v2');
    expect(vc.proof).toBeDefined();
  });
});
import './Issuer.more.part';
import './Issuer.unsupported.part';
