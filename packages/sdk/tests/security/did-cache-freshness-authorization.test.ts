import { describe, test, expect, spyOn } from 'bun:test';
import { DIDManager } from '../../src/did/DIDManager';
import { Verifier } from '../../src/vc/Verifier';
import { Issuer } from '../../src/vc/Issuer';
import { createDocumentLoader } from '../../src/vc/documentLoader';
import { multikey } from '@originals/cel';
import * as ed25519 from '@noble/ed25519';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Regression for issue #602: a mutable DID's cache entry (however recent,
 * even pinned) must never be accepted as evidence that a key is PRESENTLY
 * authorized. An externally-performed did:webvh rotation (a different
 * process/host — DIDManager.invalidateCachedDID only clears the mutating
 * instance's own cache) must be visible immediately to any current-authority
 * check, while explicit offline/snapshot reads may still serve the cached
 * document.
 */
describe('current-authority resolution wiring (issue #602)', () => {
  const did = 'did:webvh:example.com:issuer';
  const sk = new Uint8Array(32).map((_, i) => (i + 3) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519'),
  };
  const didDocument = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [vm],
    assertionMethod: [vm.id],
    authentication: [vm.id],
  };

  test('Verifier.checkProofPurpose resolves the signer DID with mode: "current"', async () => {
    const didManager = new DIDManager({} as any);
    const spy = spyOn(didManager, 'resolveDID').mockResolvedValue(didDocument as any);

    const issuer = new Issuer(didManager, vm as any);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:key:subject' },
      } as any,
      { proofPurpose: 'assertionMethod' }
    );

    const verifier = new Verifier(didManager);
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(true);

    const calls = spy.mock.calls as unknown as Array<[string, { mode?: string } | undefined]>;
    const requestedCurrent = calls.some(([calledDid, options]) => calledDid === did && options?.mode === 'current');
    expect(requestedCurrent).toBe(true);
  });

  test('DocumentLoader.resolveDID resolves the verification method\'s DID with mode: "current"', async () => {
    const didManager = new DIDManager({} as any);
    const spy = spyOn(didManager, 'resolveDID').mockResolvedValue(didDocument as any);

    const loader = createDocumentLoader(didManager);
    const res = await loader(vm.id);
    expect((res.document as any).publicKeyMultibase).toBe(vm.publicKeyMultibase);

    expect(spy).toHaveBeenCalledWith(did, { mode: 'current' });
  });

  test('resolveDIDWithFreshness reports a genuine cache hit as "cache" even under mode: "current" for non-webvh methods', async () => {
    // mode: 'current' only forces DIDManager.resolveDID to bypass its cache
    // for did:webvh (the mutable method this issue targets). For every other
    // method, resolveDID may still legitimately serve a cached document even
    // when 'current' was requested — the metadata must say so honestly
    // rather than mislabel a cache hit as a fresh network read.
    const didManager = new DIDManager({ network: 'mainnet' } as any);
    const celDid = 'did:cel:uEiAexampleGenesisDigest';
    const celDoc = { '@context': ['https://www.w3.org/ns/did/v1'], id: celDid } as any;
    await didManager.cache.set(celDid, celDoc);

    const result = await didManager.resolveDIDWithFreshness(celDid, { mode: 'current' });
    expect(result.didDocument?.id).toBe(celDid);
    expect(result.didResolutionMetadata.source).toBe('cache');
    expect(result.didResolutionMetadata.fresh).toBe(false);
  });
});

describe('mutable DID cache cannot supply current authority (issue #602)', () => {
  test('an externally-performed did:webvh rotation is invisible to cache/offline reads but rejected by mode: "current"', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'did-freshness-'));
    const originalFetch = globalThis.fetch;
    try {
      // A publisher creates the DID; a SEPARATE DIDManager instance later
      // rotates its keys, simulating a rotation performed by another
      // process/host that this test's "verifier" instance never observes
      // directly (DIDManager.invalidateCachedDID is private and per-instance).
      const publisher = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519', webvhNetwork: 'magby' } as any);
      const created = await publisher.createDIDWebVH({ domain: 'example.com', outputDir: tempDir });

      const rotator = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519', webvhNetwork: 'magby' } as any);
      const rotated = await rotator.rotateDIDWebVHKeys({
        did: created.did,
        currentLog: created.log,
        currentKeyPair: created.keyPair,
        outputDir: tempDir,
      });
      expect(rotated.newKeyPair.publicKey).not.toBe(created.keyPair.publicKey);

      // Any live did:webvh resolution now observes the rotated log — exactly
      // what a real webvh host would serve after the rotation.
      const rotatedLogText = rotated.log.map((entry) => JSON.stringify(entry)).join('\n');
      globalThis.fetch = (async () => new Response(rotatedLogText, { status: 200 })) as unknown as typeof fetch;

      const verifier = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519', webvhNetwork: 'magby' } as any);

      // A live resolution with an empty cache already reflects the rotation.
      const live = await verifier.resolveDID(created.did);
      expect(live?.verificationMethod?.[0]?.publicKeyMultibase).toBe(rotated.newKeyPair.publicKey);

      // Now poison the cache with the STALE pre-rotation document and pin it,
      // as if it had been resolved and pinned for offline use before the
      // external rotation happened.
      await verifier.cache.set(created.did, created.didDocument);
      await verifier.cache.pin(created.did);
      expect(verifier.cache.isPinned(created.did)).toBe(true);

      // Default (cache) resolution and an explicit offline-snapshot read may
      // legitimately still serve the pinned pre-rotation document.
      const cached = await verifier.resolveDID(created.did);
      expect(cached?.verificationMethod?.[0]?.publicKeyMultibase).toBe(created.keyPair.publicKey);

      const offline = await verifier.resolveDIDWithFreshness(created.did, { mode: 'offline' });
      expect(offline.didDocument?.verificationMethod?.[0]?.publicKeyMultibase).toBe(created.keyPair.publicKey);
      expect(offline.didResolutionMetadata.source).toBe('offline-snapshot');
      expect(offline.didResolutionMetadata.pinned).toBe(true);

      // Current-authority resolution MUST NOT be satisfied by the pinned
      // stale snapshot: it must bypass the cache and observe the real
      // rotation, exactly like Verifier/DocumentLoader/the CEL key resolver
      // now require for authorization decisions.
      const current = await verifier.resolveDID(created.did, { mode: 'current' });
      expect(current?.verificationMethod?.[0]?.publicKeyMultibase).toBe(rotated.newKeyPair.publicKey);
      expect(current?.verificationMethod?.[0]?.publicKeyMultibase).not.toBe(created.keyPair.publicKey);

      const currentMeta = await verifier.resolveDIDWithFreshness(created.did, { mode: 'current' });
      expect(currentMeta.didDocument?.verificationMethod?.[0]?.publicKeyMultibase).toBe(rotated.newKeyPair.publicKey);
      expect(currentMeta.didResolutionMetadata.source).toBe('network');
      expect(currentMeta.didResolutionMetadata.fresh).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 20000);
});
