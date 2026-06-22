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
 * Regression: the global verificationMethodRegistry must NEVER override a
 * verification method that the resolved DID document actually publishes.
 *
 * Otherwise any caller of registerVerificationMethod could shadow a victim
 * DID's real key with an attacker-controlled key and forge credential
 * signatures.
 */
describe('verificationMethodRegistry must not override the DID document', () => {
  beforeEach(() => verificationMethodRegistry.clear());
  afterEach(() => verificationMethodRegistry.clear());

  test('DID-document verification method wins over a registered forgery', async () => {
    const did = 'did:peer:victim1';
    const vmId = `${did}#keys-1`;

    // The victim's REAL key, published in the DID document.
    const realSk = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
    const realPk = ed25519.getPublicKey(realSk);
    const realPkMultibase = multikey.encodePublicKey(realPk, 'Ed25519');

    // The attacker's FORGED key, registered under the same VM id.
    const forgedSk = new Uint8Array(32).map((_, i) => (i + 100) & 0xff);
    const forgedPk = ed25519.getPublicKey(forgedSk);
    const forgedPkMultibase = multikey.encodePublicKey(forgedPk, 'Ed25519');

    expect(forgedPkMultibase).not.toBe(realPkMultibase);

    const didManager = new DIDManager({ network: 'mainnet', defaultKeyType: 'Ed25519' } as any);
    const resolveSpy = spyOn(didManager, 'resolveDID').mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did,
      verificationMethod: [
        { id: vmId, type: 'Multikey', controller: did, publicKeyMultibase: realPkMultibase }
      ]
    } as any);

    // Attacker injects a forged key under the victim's VM id.
    registerVerificationMethod({
      id: vmId,
      type: 'Multikey',
      controller: did,
      publicKeyMultibase: forgedPkMultibase
    });

    const loader = createDocumentLoader(didManager);
    const res = await loader(vmId);

    // The DID document's real key must be returned, NOT the forged one.
    expect((res.document as any).publicKeyMultibase).toBe(realPkMultibase);
    expect((res.document as any).publicKeyMultibase).not.toBe(forgedPkMultibase);

    resolveSpy.mockRestore();
  });

  test('registry still serves as fallback when the DID document omits the VM', async () => {
    const did = 'did:peer:stub1';
    const vmId = `${did}#keys-1`;
    const sk = new Uint8Array(32).map((_, i) => (i + 7) & 0xff);
    const pk = ed25519.getPublicKey(sk);
    const pkMultibase = multikey.encodePublicKey(pk, 'Ed25519');

    const didManager = new DIDManager({ network: 'mainnet', defaultKeyType: 'Ed25519' } as any);
    const resolveSpy = spyOn(didManager, 'resolveDID').mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did
      // no verificationMethod published
    } as any);

    registerVerificationMethod({ id: vmId, type: 'Multikey', controller: did, publicKeyMultibase: pkMultibase });

    const loader = createDocumentLoader(didManager);
    const res = await loader(vmId);

    expect((res.document as any).publicKeyMultibase).toBe(pkMultibase);
    resolveSpy.mockRestore();
  });
});
