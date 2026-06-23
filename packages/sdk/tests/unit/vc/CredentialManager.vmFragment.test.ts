import { describe, test, expect } from 'bun:test';
import { CredentialManager } from '../../../src';
import { DIDManager } from '../../../src/did/DIDManager';

const config: any = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false
};

// Regression test for plan 028: CredentialManager.resolveVerificationMethodMultibase
// fallback must use two-stage matching (exact id, then fragment), mirroring the CEL
// keyResolver. Previously the fallback used an exact string match only, so a DID
// document that publishes a verification method under a *relative* id
// (e.g. "#keys-1") would not be found when the proof references the *absolute*
// form ("did:webvh:example.com:asset#keys-1"), causing legitimate credentials
// signed with a published key to fail verification.
describe('CredentialManager - VM fragment fallback resolution', () => {
  const issuerDid = 'did:webvh:example.com:asset';
  const absoluteVm = `${issuerDid}#keys-1`;
  const publicKeyMultibase = 'z6MkfakeKeyForResolutionTestOnlyNotUsedToVerify';

  function makeDidManager(vmId: string): DIDManager {
    const didManager = new DIDManager(config);
    // Force the documentLoader path to miss its publicKeyMultibase (the loader
    // also matches by absolute id, so a relative-id VM is not surfaced there
    // either) and exercise the fallback resolveDID branch directly.
    (didManager as any).resolveDID = async (did: string) => {
      if (did !== issuerDid) return null;
      return {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: issuerDid,
        verificationMethod: [
          { id: vmId, type: 'Multikey', controller: issuerDid, publicKeyMultibase }
        ]
      };
    };
    return didManager;
  }

  test('resolves a published VM when proof uses absolute id and document uses relative id', async () => {
    const didManager = makeDidManager('#keys-1');
    const credentialManager = new CredentialManager(config, didManager);

    const resolved = await (credentialManager as any).resolveVerificationMethodMultibase(
      absoluteVm,
      issuerDid
    );

    expect(resolved).toBe(publicKeyMultibase);
  });

  test('still resolves when both proof and document use the absolute id (exact match)', async () => {
    const didManager = makeDidManager(absoluteVm);
    const credentialManager = new CredentialManager(config, didManager);

    const resolved = await (credentialManager as any).resolveVerificationMethodMultibase(
      absoluteVm,
      issuerDid
    );

    expect(resolved).toBe(publicKeyMultibase);
  });

  test('does not resolve a VM whose fragment differs', async () => {
    const didManager = makeDidManager('#keys-2');
    const credentialManager = new CredentialManager(config, didManager);

    const resolved = await (credentialManager as any).resolveVerificationMethodMultibase(
      absoluteVm,
      issuerDid
    );

    expect(resolved).toBeNull();
  });

  test('does not resolve when the VM belongs to a different DID than the issuer', async () => {
    const didManager = makeDidManager('#keys-1');
    const credentialManager = new CredentialManager(config, didManager);

    // issuer-binding check should reject before any document lookup
    const resolved = await (credentialManager as any).resolveVerificationMethodMultibase(
      absoluteVm,
      'did:webvh:example.com:other'
    );

    expect(resolved).toBeNull();
  });
});
