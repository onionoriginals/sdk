/**
 * Regression tests for the did:webvh write-path cluster (issues #338, #339,
 * #334): WebVHManager's calls into didwebvh-ts must match the options the
 * library actually consumes (verified against didwebvh-ts@2.8.0).
 *
 *  #338 — updateDIDWebVH passed `doc`, which updateDID ignores → every
 *         update was a signed no-op re-stating the previous document.
 *  #339 — rotate/recover passed only the new signing VM → didwebvh-ts
 *         rebuilt the whole VM/relationship block, wiping keyAgreement,
 *         capability relationships, and all carried verification methods.
 *  #334 — the internal key-pair paths authorized ['#key-0'] but built the VM
 *         without an id, so didwebvh-ts assigned a key-derived id and the
 *         relationship arrays dangled — third-party proof-purpose
 *         verification failed.
 *
 * These tests assert SEMANTICS (state round-trips through the library's own
 * log resolution), not log length.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { WebVHManager } from '../../../src/did/WebVHManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { Ed25519Verifier } from '../../../src/did/Ed25519Verifier';
import { OriginalsSDK } from '../../../src';
import type { DIDDocument, VerifiableCredential } from '../../../src/types';

/** Resolve a DID document from its log — the trust path a real verifier uses. */
async function resolveFromLog(log: unknown): Promise<DIDDocument> {
  const mod = await import('didwebvh-ts') as unknown as {
    resolveDIDFromLog: (
      log: unknown,
      options?: Record<string, unknown>
    ) => Promise<{ did: string; doc: Record<string, unknown> | null }>;
  };
  const resolved = await mod.resolveDIDFromLog(log, { verifier: new Ed25519Verifier() });
  expect(resolved.doc).toBeTruthy();
  return resolved.doc as unknown as DIDDocument;
}

/** Relationship entries as string references (embedded VMs → their id). */
function relationshipRefs(rel?: (string | { id?: string })[]): string[] {
  return (rel ?? []).map(e => (typeof e === 'string' ? e : e?.id ?? '')).filter(Boolean);
}

const fragmentOf = (ref: string): string | undefined => ref.split('#')[1];

/** True when some entry in the relationship references the given fragment. */
function referencesFragment(rel: (string | { id?: string })[] | undefined, fragment: string): boolean {
  return relationshipRefs(rel).some(ref => fragmentOf(ref) === fragment);
}

describe('#338 — updateDIDWebVH applies updates through the options didwebvh-ts consumes', () => {
  test('adding a service round-trips: returned doc, new log entry state, and log resolution', async () => {
    const manager = new WebVHManager();
    const created = await manager.createDIDWebVH({ domain: 'example.com' });

    const newService = {
      id: `${created.did}#files`,
      type: 'LinkedDomains',
      serviceEndpoint: 'https://files.example.com',
    };

    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { service: [newService] },
      signer: created.keyPair!,
    });

    // The update must actually be applied — not a signed no-op (issue #338).
    expect(updated.didDocument.service).toEqual([newService]);

    const newEntry = updated.log[updated.log.length - 1];
    expect((newEntry.state as { service?: unknown }).service).toEqual([newService]);

    // And a conformant resolver derives the same state from the log (the
    // resolver also injects the spec's implicit services, e.g. '#whois', so
    // assert containment rather than equality).
    const resolvedDoc = await resolveFromLog(updated.log);
    expect(resolvedDoc.service).toContainEqual(newService);
  }, 30000);

  test('a service-only update leaves verification methods and relationships untouched', async () => {
    const manager = new WebVHManager();
    const keyManager = new KeyManager();
    const carried = await keyManager.generateKeyPair('Ed25519');

    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      additionalVerificationMethods: [
        { id: '#key-agreement-1', type: 'Multikey', publicKeyMultibase: carried.publicKey, purpose: 'keyAgreement' },
      ],
    });
    const beforeVMs = created.didDocument.verificationMethod ?? [];
    expect(beforeVMs.length).toBe(2);

    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { service: [{ id: `${created.did}#svc`, type: 'Svc', serviceEndpoint: 'https://svc.example.com' }] },
      signer: created.keyPair!,
    });

    const doc = updated.didDocument;
    expect((doc.verificationMethod ?? []).length).toBe(2);
    expect(referencesFragment(doc.keyAgreement, 'key-agreement-1')).toBe(true);
    expect(referencesFragment(doc.authentication, 'key-0')).toBe(true);
    expect(referencesFragment(doc.assertionMethod, 'key-0')).toBe(true);
  }, 30000);

  test('adding a verification method with keyAgreement round-trips through log resolution', async () => {
    const manager = new WebVHManager();
    const keyManager = new KeyManager();
    const created = await manager.createDIDWebVH({ domain: 'example.com' });
    const extra = await keyManager.generateKeyPair('Ed25519');

    const currentDoc = created.didDocument;
    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: {
        verificationMethod: [
          ...(currentDoc.verificationMethod ?? []),
          { id: '#key-1', type: 'Multikey', controller: created.did, publicKeyMultibase: extra.publicKey },
        ],
        keyAgreement: ['#key-1'],
      },
      signer: created.keyPair!,
    });

    const resolvedDoc = await resolveFromLog(updated.log);
    const vms = resolvedDoc.verificationMethod ?? [];
    expect(vms.some(vm => vm.publicKeyMultibase === extra.publicKey)).toBe(true);
    expect(referencesFragment(resolvedDoc.keyAgreement, 'key-1')).toBe(true);
    // The signing key keeps its roles.
    expect(referencesFragment(resolvedDoc.authentication, 'key-0')).toBe(true);
    expect(referencesFragment(resolvedDoc.assertionMethod, 'key-0')).toBe(true);
  }, 30000);

  test('rejects update fields didwebvh-ts has no option for (no silent drop)', async () => {
    const manager = new WebVHManager();
    const created = await manager.createDIDWebVH({ domain: 'example.com' });

    await expect(manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { controller: ['did:example:other'] } as Partial<DIDDocument>,
      signer: created.keyPair!,
    })).rejects.toThrow(/cannot apply updates to "controller"/);
  }, 30000);
});

describe('#339 — rotation/recovery preserve carried verification methods and relationships', () => {
  async function createMultiKeyDID(manager: WebVHManager, keyManager: KeyManager) {
    const keyAgreementKey = await keyManager.generateKeyPair('Ed25519');
    const capabilityKey = await keyManager.generateKeyPair('Ed25519');
    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      additionalVerificationMethods: [
        { id: '#key-agreement-1', type: 'Multikey', publicKeyMultibase: keyAgreementKey.publicKey, purpose: 'keyAgreement' },
        { id: '#capability-1', type: 'Multikey', publicKeyMultibase: capabilityKey.publicKey, purpose: 'capabilityInvocation' },
      ],
    });
    // Sanity: the created document holds all three VMs with their relationships.
    const doc = created.didDocument;
    expect((doc.verificationMethod ?? []).length).toBe(3);
    expect(referencesFragment(doc.keyAgreement, 'key-agreement-1')).toBe(true);
    expect(referencesFragment(doc.capabilityInvocation, 'capability-1')).toBe(true);
    return { created, keyAgreementKey, capabilityKey };
  }

  function assertCarriedVMsSurvive(
    doc: DIDDocument,
    newPublicKey: string,
    oldPublicKey: string,
    keyAgreementPub: string,
    capabilityPub: string
  ) {
    const vms = doc.verificationMethod ?? [];
    // Rotation replaces ONLY the signing key: 3 VMs before, 3 after.
    expect(vms.length).toBe(3);
    expect(vms.some(vm => vm.publicKeyMultibase === newPublicKey)).toBe(true);
    expect(vms.some(vm => vm.publicKeyMultibase === oldPublicKey)).toBe(false);
    expect(vms.some(vm => vm.publicKeyMultibase === keyAgreementPub)).toBe(true);
    expect(vms.some(vm => vm.publicKeyMultibase === capabilityPub)).toBe(true);
    // Relationships survive and the signing roles move to the new key.
    expect(referencesFragment(doc.keyAgreement, 'key-agreement-1')).toBe(true);
    expect(referencesFragment(doc.capabilityInvocation, 'capability-1')).toBe(true);
    expect(referencesFragment(doc.authentication, 'key-0')).toBe(true);
    expect(referencesFragment(doc.assertionMethod, 'key-0')).toBe(true);
    // Every relationship reference resolves to a published VM (no dangling).
    const vmFragments = new Set(vms.map(vm => fragmentOf(vm.id ?? '')).filter(Boolean));
    for (const rel of [doc.authentication, doc.assertionMethod, doc.keyAgreement, doc.capabilityInvocation]) {
      for (const ref of relationshipRefs(rel)) {
        expect(vmFragments.has(fragmentOf(ref))).toBe(true);
      }
    }
  }

  test('rotateDIDWebVHKeys on a multi-key DID preserves keyAgreement and capability VMs', async () => {
    const manager = new WebVHManager();
    const keyManager = new KeyManager();
    const { created, keyAgreementKey, capabilityKey } = await createMultiKeyDID(manager, keyManager);

    const rotated = await manager.rotateDIDWebVHKeys({
      did: created.did,
      currentLog: created.log,
      currentKeyPair: created.keyPair!,
    });

    assertCarriedVMsSurvive(
      rotated.didDocument,
      rotated.newKeyPair.publicKey,
      created.keyPair!.publicKey,
      keyAgreementKey.publicKey,
      capabilityKey.publicKey
    );

    // The rotated log must still resolve, and resolution must agree.
    const resolvedDoc = await resolveFromLog(rotated.log);
    assertCarriedVMsSurvive(
      resolvedDoc,
      rotated.newKeyPair.publicKey,
      created.keyPair!.publicKey,
      keyAgreementKey.publicKey,
      capabilityKey.publicKey
    );
  }, 30000);

  test('recoverDIDWebVH preserves carried VMs — the recovered doc matches its own KeyRecoveryCredential', async () => {
    const manager = new WebVHManager();
    const keyManager = new KeyManager();
    const { created, keyAgreementKey, capabilityKey } = await createMultiKeyDID(manager, keyManager);

    const recovered = await manager.recoverDIDWebVH({
      did: created.did,
      currentLog: created.log,
      signingKeyPair: created.keyPair!,
    });

    assertCarriedVMsSurvive(
      recovered.didDocument,
      recovered.newKeyPair.publicKey,
      created.keyPair!.publicKey,
      keyAgreementKey.publicKey,
      capabilityKey.publicKey
    );
    const resolvedDoc = await resolveFromLog(recovered.log);
    assertCarriedVMsSurvive(
      resolvedDoc,
      recovered.newKeyPair.publicKey,
      created.keyPair!.publicKey,
      keyAgreementKey.publicKey,
      capabilityKey.publicKey
    );
  }, 30000);

  test('pre-rotation rotation preserves carried VMs', async () => {
    const manager = new WebVHManager();
    const keyManager = new KeyManager();
    const carried = await keyManager.generateKeyPair('Ed25519');

    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      prerotation: true,
      additionalVerificationMethods: [
        { id: '#key-agreement-1', type: 'Multikey', publicKeyMultibase: carried.publicKey, purpose: 'keyAgreement' },
      ],
    });

    const rotated = await manager.rotateDIDWebVHKeys({
      did: created.did,
      currentLog: created.log,
      currentKeyPair: created.nextKeyPair!,
      prerotation: true,
    });

    const doc = rotated.didDocument;
    expect((doc.verificationMethod ?? []).some(vm => vm.publicKeyMultibase === carried.publicKey)).toBe(true);
    expect(referencesFragment(doc.keyAgreement, 'key-agreement-1')).toBe(true);
    expect(referencesFragment(doc.authentication, 'key-0')).toBe(true);

    const resolvedDoc = await resolveFromLog(rotated.log);
    expect(referencesFragment(resolvedDoc.keyAgreement, 'key-agreement-1')).toBe(true);
  }, 30000);

  test('rotation rejects a non-Ed25519 replacement key instead of bricking the DID', async () => {
    const manager = new WebVHManager();
    const keyManager = new KeyManager();
    const created = await manager.createDIDWebVH({ domain: 'example.com' });
    const es256k = await keyManager.generateKeyPair('ES256K');

    await expect(manager.rotateDIDWebVHKeys({
      did: created.did,
      currentLog: created.log,
      currentKeyPair: created.keyPair!,
      newKeyPair: es256k,
    })).rejects.toThrow(/Ed25519/);
  }, 30000);
});

describe('#334 — relationship arrays reference the published signing VM', () => {
  test('created document publishes the signing VM as #key-0 and every relationship ref resolves', async () => {
    const manager = new WebVHManager();
    const created = await manager.createDIDWebVH({ domain: 'example.com' });

    const resolvedDoc = await resolveFromLog(created.log);
    const vms = resolvedDoc.verificationMethod ?? [];
    expect(vms.length).toBe(1);
    expect(fragmentOf(vms[0].id ?? '')).toBe('key-0');
    expect(vms[0].publicKeyMultibase).toBe(created.keyPair!.publicKey);

    for (const rel of [resolvedDoc.authentication, resolvedDoc.assertionMethod]) {
      const entries = relationshipRefs(rel);
      expect(entries.length).toBeGreaterThan(0);
      for (const ref of entries) {
        expect(fragmentOf(ref)).toBe('key-0');
      }
    }
  }, 30000);

  test('create → resolve from log → verifyCredential succeeds (the #334 repro)', async () => {
    const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
    const created = await sdk.did.createDIDWebVH({ domain: 'example.com' });

    // Resolve the document from the signed log — the correct trust path a
    // third-party verifier uses — and pin DID resolution to it.
    const resolvedDoc = await resolveFromLog(created.log);
    const resolveSpy = spyOn(sdk.did, 'resolveDID').mockResolvedValue(resolvedDoc);
    try {
      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
        type: ['VerifiableCredential', 'ResourceCreated'],
        issuer: created.did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: {
          id: created.did,
          resourceId: 'res-334',
          resourceType: 'text',
          createdAt: new Date().toISOString(),
          creator: created.did,
        },
      };

      const signed = await sdk.credentials.signCredential(
        credential,
        created.keyPair!.privateKey,
        `${created.did}#key-0`
      );
      expect(signed.proof).toBeDefined();

      // Before the fix, the resolved doc's assertionMethod (['#key-0'])
      // referenced a fragment no VM had, so proof-purpose verification
      // rejected every credential issued with the DID.
      await expect(sdk.credentials.verifyCredential(signed)).resolves.toBe(true);
    } finally {
      resolveSpy.mockRestore();
    }
  }, 30000);

  test('external-signer path without VM ids gets #key-0 assigned so relationships resolve', async () => {
    const keyManager = new KeyManager();
    const keyPair = await keyManager.generateKeyPair('Ed25519');
    const mod = await import('didwebvh-ts') as unknown as {
      prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>;
    };
    const { Ed25519Signer } = await import('../../../src/crypto/Signer');
    const { multikey } = await import('../../../src/crypto/Multikey');
    const raw = new Ed25519Signer();
    const externalSigner = {
      getVerificationMethodId: () => `did:key:${keyPair.publicKey}`,
      async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }) {
        const data = await mod.prepareDataForSigning(input.document, input.proof);
        const sig: Buffer = await raw.sign(Buffer.from(data), keyPair.privateKey);
        return { proofValue: multikey.encodeMultibase(sig) };
      },
    };
    const externalVerifier = new Ed25519Verifier();

    const manager = new WebVHManager();
    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      externalSigner,
      externalVerifier,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [keyPair.publicKey],
    });

    const resolvedDoc = await resolveFromLog(created.log);
    const vms = resolvedDoc.verificationMethod ?? [];
    expect(fragmentOf(vms[0].id ?? '')).toBe('key-0');
    expect(relationshipRefs(resolvedDoc.authentication).every(ref => fragmentOf(ref) === 'key-0')).toBe(true);
    expect(relationshipRefs(resolvedDoc.assertionMethod).every(ref => fragmentOf(ref) === 'key-0')).toBe(true);
  }, 30000);
});
