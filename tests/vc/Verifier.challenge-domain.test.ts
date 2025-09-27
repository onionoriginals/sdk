import { Verifier } from '../../src/vc/Verifier';
import { Issuer } from '../../src/vc/Issuer';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { registerVerificationMethod } from '../../src/vc/documentLoader';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier presentation challenge/domain', () => {
  const didManager = new DIDManager({} as any);
  const did = 'did:peer:holder1';
  const sk = new Uint8Array(32).map((_, i) => (i + 7) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
  };
  registerVerificationMethod(vm);

  test('happy path - challenge and domain match', async () => {
    const issuer = new Issuer(didManager, vm);
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: []
      } as any,
      { proofPurpose: 'authentication', challenge: 'chal-123', domain: 'example.org' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyPresentation(vp, { expectedChallenge: 'chal-123', expectedDomain: 'example.org' });
    expect(res.verified).toBe(true);
  });

  test('negative - wrong challenge', async () => {
    const issuer = new Issuer(didManager, vm);
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: []
      } as any,
      { proofPurpose: 'authentication', challenge: 'chal-xyz', domain: 'example.org' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyPresentation(vp, { expectedChallenge: 'other', expectedDomain: 'example.org' });
    expect(res.verified).toBe(false);
  });

  test('negative - wrong domain', async () => {
    const issuer = new Issuer(didManager, vm);
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: []
      } as any,
      { proofPurpose: 'authentication', challenge: 'chal-123', domain: 'bad.example' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyPresentation(vp, { expectedChallenge: 'chal-123', expectedDomain: 'example.org' });
    expect(res.verified).toBe(false);
  });
});

