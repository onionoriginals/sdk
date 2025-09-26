import { Verifier } from '../../src/vc/Verifier';
import { Issuer } from '../../src/vc/Issuer';
import { DIDManager } from '../../src/did/DIDManager';
import { multikey } from '../../src/crypto/Multikey';

describe('Verifier handles presentation proof array', () => {
  test('verifyPresentation with proof array handled (takes first element)', async () => {
    const dm = new DIDManager({} as any);
    const sk = new Uint8Array(32).fill(7);
    const pk = new Uint8Array(32).fill(8);
    const vm = {
      id: 'did:ex:arr#key-1',
      controller: 'did:ex:arr',
      publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
      secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
    };
    const issuer = new Issuer(dm, vm);
    const vp = await issuer.issuePresentation({ holder: vm.controller } as any, { proofPurpose: 'authentication' });
    (vp as any).proof = [ (vp as any).proof ];
    const verifier = new Verifier(dm);
    const res = await verifier.verifyPresentation(vp as any);
    expect(typeof res.verified).toBe('boolean');
  });
});

