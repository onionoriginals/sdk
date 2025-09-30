import { Verifier } from '../../src/vc/Verifier';
import { Issuer } from '../../src/vc/Issuer';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { registerVerificationMethod } from '../../src/vc/documentLoader';
import { DIDManager } from '../../src/did/DIDManager';
import { updateStatusList, setStatusListIndex } from '../../src/vc/status/StatusListRegistry';

describe('Revocation via Status List', () => {
  const didManager = new DIDManager({} as any);
  const did = 'did:peer:issuer-rev';
  const sk = new Uint8Array(32).map((_, i) => (i + 11) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
  };
  registerVerificationMethod(vm);

  const statusListCredentialId = 'https://example.org/status-lists/list-1';
  const statusIndex = 42;

  test('revocation list update invalidates credential', async () => {
    // Initial status list: nothing revoked
    updateStatusList(statusListCredentialId, []);

    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Revocable'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:example:subj' },
        credentialStatus: {
          id: `${statusListCredentialId}#${statusIndex}`,
          type: 'StatusList2021Entry',
          statusListIndex: String(statusIndex),
          statusListCredential: statusListCredentialId
        } as any
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const verifier = new Verifier(didManager);

    // Happy path: not revoked yet
    let res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(true);

    // Revoke by updating status list
    setStatusListIndex(statusListCredentialId, statusIndex, true);

    // Now verification should fail
    res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(false);
  });
});

