import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { KeyManager } from '../../src/did/KeyManager';
import { createBtcoDidDocument } from '../../src/did/createBtcoDidDocument';
import { multikey } from '../../src/crypto/Multikey';
import { DIDManager } from '../../src/did/DIDManager';
import { Issuer } from '../../src/vc/Issuer';
import { Verifier } from '../../src/vc/Verifier';
import { registerVerificationMethod, verificationMethodRegistry } from '../../src/vc/documentLoader';

describe('Multikey end-to-end pipeline', () => {
  beforeEach(() => {
    verificationMethodRegistry.clear();
  });

  afterEach(() => {
    verificationMethodRegistry.clear();
  });

  test('generates keys, embeds DID, issues and verifies credential', async () => {
    const km = new KeyManager();
    const keyPair = await km.generateKeyPair('Ed25519');
    const decoded = multikey.decodePublicKey(keyPair.publicKey);
    const didDoc = createBtcoDidDocument(123, 'mainnet', {
      publicKey: decoded.key,
      keyType: decoded.type
    });
    const vm = didDoc.verificationMethod?.[0];
    if (!vm) {
      throw new Error('Missing verification method');
    }
    registerVerificationMethod(vm);

    const didManager = new DIDManager({ network: 'mainnet', defaultKeyType: 'Ed25519' } as any);
    const resolveSpy = spyOn(didManager, 'resolveDID').mockResolvedValue(didDoc);

    const issuer = new Issuer(didManager, { ...vm, secretKeyMultibase: keyPair.privateKey });
    const unsigned: any = {
      id: 'urn:cred:example',
      type: ['VerifiableCredential'],
      issuer: didDoc.id,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:example:subject' }
    };
    const vc = await issuer.issueCredential(unsigned, { proofPurpose: 'assertionMethod' });

    const verifier = new Verifier(didManager);
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(true);

    resolveSpy.mockRestore();
  });
});
