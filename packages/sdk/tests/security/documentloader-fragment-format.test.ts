import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { DIDManager } from '../../src/did/DIDManager';
import {
  createDocumentLoader,
  registerVerificationMethod,
  verificationMethodRegistry
} from '../../src/vc/documentLoader';
import { multikey } from '../../src/crypto/Multikey';
import * as ed25519 from '@noble/ed25519';

/**
 * Regression: DocumentLoader.resolveDID must match the requested verification
 * method against the resolved DID document even when the document publishes the
 * VM with a RELATIVE fragment id (e.g. `#key-0`) and the request uses the
 * ABSOLUTE form (`did:example:123#key-0`). Both are equivalent per DID Core.
 *
 * If the loader uses an exact string match it fails to find the published VM,
 * then either (a) falls back to the global registry — re-opening the
 * signature-forgery hole — or (b) returns a stub without publicKeyMultibase,
 * breaking verification of legitimate credentials.
 */
describe('DocumentLoader matches VMs across relative/absolute fragment ids', () => {
  beforeEach(() => verificationMethodRegistry.clear());
  afterEach(() => verificationMethodRegistry.clear());

  test('relative-id VM in DID document is found when absolute id is requested', async () => {
    const did = 'did:peer:relativevm';
    const absoluteVmId = `${did}#key-0`;

    const realSk = new Uint8Array(32).map((_, i) => (i + 7) & 0xff);
    const realPk = ed25519.getPublicKey(realSk);
    const realPkMultibase = multikey.encodePublicKey(realPk, 'Ed25519');

    const didManager = new DIDManager({ network: 'mainnet', defaultKeyType: 'Ed25519' } as any);
    spyOn(didManager, 'resolveDID').mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      // Published with a RELATIVE id, as did:peer / webvh relationships do.
      verificationMethod: [
        { id: '#key-0', type: 'Multikey', controller: did, publicKeyMultibase: realPkMultibase }
      ]
    } as any);

    const loader = createDocumentLoader(didManager);
    const res = await loader(absoluteVmId);

    // Must carry the DID document's real key material, not a stub.
    expect((res.document as any).publicKeyMultibase).toBe(realPkMultibase);
  });

  test('relative-id VM in DID document wins over a registered forgery under the absolute id', async () => {
    const did = 'did:peer:relativevm2';
    const absoluteVmId = `${did}#key-0`;

    const realSk = new Uint8Array(32).map((_, i) => (i + 11) & 0xff);
    const realPk = ed25519.getPublicKey(realSk);
    const realPkMultibase = multikey.encodePublicKey(realPk, 'Ed25519');

    const forgedSk = new Uint8Array(32).map((_, i) => (i + 200) & 0xff);
    const forgedPk = ed25519.getPublicKey(forgedSk);
    const forgedPkMultibase = multikey.encodePublicKey(forgedPk, 'Ed25519');
    expect(forgedPkMultibase).not.toBe(realPkMultibase);

    const didManager = new DIDManager({ network: 'mainnet', defaultKeyType: 'Ed25519' } as any);
    spyOn(didManager, 'resolveDID').mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      verificationMethod: [
        { id: '#key-0', type: 'Multikey', controller: did, publicKeyMultibase: realPkMultibase }
      ]
    } as any);

    // Attacker registers a forged key under the ABSOLUTE id, betting on the
    // format mismatch to bypass the published (relative-id) VM.
    registerVerificationMethod({
      id: absoluteVmId,
      type: 'Multikey',
      controller: did,
      publicKeyMultibase: forgedPkMultibase
    });

    const loader = createDocumentLoader(didManager);
    const res = await loader(absoluteVmId);

    // The DID document's real key must win.
    expect((res.document as any).publicKeyMultibase).toBe(realPkMultibase);
    expect((res.document as any).publicKeyMultibase).not.toBe(forgedPkMultibase);
  });

  test('absolute-id VM in DID document is found when relative id is requested via base', async () => {
    const did = 'did:peer:absolutevm';
    const absoluteVmId = `${did}#key-0`;

    const realSk = new Uint8Array(32).map((_, i) => (i + 13) & 0xff);
    const realPk = ed25519.getPublicKey(realSk);
    const realPkMultibase = multikey.encodePublicKey(realPk, 'Ed25519');

    const didManager = new DIDManager({ network: 'mainnet', defaultKeyType: 'Ed25519' } as any);
    spyOn(didManager, 'resolveDID').mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      // Published with the ABSOLUTE id.
      verificationMethod: [
        { id: absoluteVmId, type: 'Multikey', controller: did, publicKeyMultibase: realPkMultibase }
      ]
    } as any);

    const loader = createDocumentLoader(didManager);
    const res = await loader(absoluteVmId);

    expect((res.document as any).publicKeyMultibase).toBe(realPkMultibase);
  });
});
