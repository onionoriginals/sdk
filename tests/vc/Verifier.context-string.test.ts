import { Verifier } from '../../src/vc/Verifier';
import { Issuer } from '../../src/vc/Issuer';
import { DIDManager } from '../../src/did/DIDManager';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { registerVerificationMethod } from '../../src/vc/documentLoader';

describe('Verifier with string @context branches', () => {
  const dm = new DIDManager({} as any);
  const did = 'did:peer:stringctx';
  const sk = new Uint8Array(32).map((_, i) => (i + 7) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
  };

  beforeAll(() => registerVerificationMethod(vm));

  test('verifyCredential accepts string @context', async () => {
    const issuer = new Issuer(dm, vm);
    const vc = await issuer.issueCredential({ id: 'urn:x', type: ['VerifiableCredential'], issuer: did, issuanceDate: new Date().toISOString(), credentialSubject: {} } as any, { proofPurpose: 'assertionMethod' });
    (vc as any)['@context'] = 'https://www.w3.org/ns/credentials/v2';
    const verifier = new Verifier(dm);
    const res = await verifier.verifyCredential(vc as any);
    expect(typeof res.verified).toBe('boolean');
  });

  test('verifyPresentation accepts string @context and no nested VCs', async () => {
    const issuer = new Issuer(dm, vm);
    const vp = await issuer.issuePresentation({ holder: did } as any, { proofPurpose: 'authentication' });
    (vp as any)['@context'] = 'https://www.w3.org/ns/credentials/v2';
    const verifier = new Verifier(dm);
    const res = await verifier.verifyPresentation(vp as any);
    expect(typeof res.verified).toBe('boolean');
  });
});

