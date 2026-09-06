/**
 * OriginalsSigner adapters (plan 039): raw-key/keyStore/ExternalSigner inward,
 * CelSigner/ExternalSigner outward. The outward bridges are correct by
 * construction — their outputs must verify through the SDK's own verifiers.
 */

import { describe, test, expect } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  canonicalDidKeyVm,
  signerFromKeyPair,
  signerFromKeyStore,
  signerFromExternalSigner,
  toCelSigner,
  toExternalSigner,
  type OriginalsSigner,
} from '../../../src/crypto/OriginalsSigner';
import { MockRemoteSigner } from '../../../src/crypto/MockRemoteSigner';
import { signingInput } from '../../../src/crypto/signingInput';
import { multikey } from '@originals/cel';
import { KeyManager } from '../../../src/did/KeyManager';
import { verifyDidKeyProof, CEL_CRYPTOSUITE } from '@originals/cel';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import type { ExternalSigner } from '../../../src/types';

async function ed25519KeyPair() {
  return new KeyManager().generateKeyPair('Ed25519');
}

describe('signerFromKeyPair', () => {
  test('exposes the canonical did:key VM and signs verifiably', async () => {
    const kp = await ed25519KeyPair();
    const signer = signerFromKeyPair(kp);
    expect(signer.publicKeyMultibase).toBe(kp.publicKey);
    expect(signer.verificationMethodId).toBe(canonicalDidKeyVm(kp.publicKey));

    const msg = new TextEncoder().encode('bytes-to-sign');
    const sig = await signer.signBytes(msg);
    const pub = multikey.decodePublicKey(kp.publicKey).key;
    expect(ed25519.verify(sig, msg, pub)).toBe(true);
  });

  test('rejects a mismatched Ed25519 pair loudly', async () => {
    const a = await ed25519KeyPair();
    const b = await ed25519KeyPair();
    expect(() => signerFromKeyPair({ privateKey: a.privateKey, publicKey: b.publicKey }))
      .toThrow(/does not derive/);
  });

  test('rejects a cross-type pair', async () => {
    const ed = await ed25519KeyPair();
    const secp = await new KeyManager().generateKeyPair('ES256K');
    expect(() => signerFromKeyPair({ privateKey: secp.privateKey, publicKey: ed.publicKey }))
      .toThrow(/type mismatch/);
  });
});

describe('signerFromKeyStore', () => {
  test('lazy per-sign lookup: key registered AFTER construction still signs', async () => {
    const kp = await ed25519KeyPair();
    const keyStore = new MockKeyStore();
    const vm = canonicalDidKeyVm(kp.publicKey);
    const signer = signerFromKeyStore(keyStore, vm);

    // Not registered yet — fails at sign time, not construction time.
    await expect(signer.signBytes(new Uint8Array([1]))).rejects.toThrow(/No private key/);

    await keyStore.setPrivateKey(vm, kp.privateKey);
    const msg = new TextEncoder().encode('late-bound');
    const sig = await signer.signBytes(msg);
    expect(ed25519.verify(sig, msg, multikey.decodePublicKey(kp.publicKey).key)).toBe(true);
  });

  test('derives the public key from a did:key VM; requires it otherwise', async () => {
    const kp = await ed25519KeyPair();
    const keyStore = new MockKeyStore();
    expect(signerFromKeyStore(keyStore, canonicalDidKeyVm(kp.publicKey)).publicKeyMultibase)
      .toBe(kp.publicKey);
    expect(() => signerFromKeyStore(keyStore, 'did:webvh:example.com:user#key-0'))
      .toThrow(/publicKeyMultibase/);
    const explicit = signerFromKeyStore(keyStore, 'did:webvh:example.com:user#key-0',
      { publicKeyMultibase: kp.publicKey });
    expect(explicit.publicKeyMultibase).toBe(kp.publicKey);
  });
});

describe('signerFromExternalSigner', () => {
  function externalOf(kp: { privateKey: string; publicKey: string }): ExternalSigner {
    const secret = multikey.decodePrivateKey(kp.privateKey).key;
    return {
      getVerificationMethodId: () => canonicalDidKeyVm(kp.publicKey),
      sign: async () => { throw new Error('document-level sign() must not be used'); },
      signBytes: async (data: Uint8Array) => ({ signature: ed25519.sign(data, secret) }),
    };
  }

  test('adapts a signBytes-capable ExternalSigner', async () => {
    const kp = await ed25519KeyPair();
    const signer = signerFromExternalSigner(externalOf(kp));
    expect(signer.publicKeyMultibase).toBe(kp.publicKey);
    const msg = new TextEncoder().encode('adapted');
    const sig = await signer.signBytes(msg);
    expect(ed25519.verify(sig, msg, multikey.decodePublicKey(kp.publicKey).key)).toBe(true);
  });

  test('throws loudly for a sign()-only ExternalSigner', async () => {
    const kp = await ed25519KeyPair();
    const signOnly: ExternalSigner = {
      getVerificationMethodId: () => canonicalDidKeyVm(kp.publicKey),
      sign: async () => ({ proofValue: 'zWhatever' }),
    };
    expect(() => signerFromExternalSigner(signOnly)).toThrow(/signBytes/);
  });
});

describe('toCelSigner', () => {
  test('produces a CEL proof that self-verifies (did:key, offline)', async () => {
    const remote = new MockRemoteSigner();
    const celSigner = toCelSigner(remote);
    const eventBase = { type: 'create', data: { name: 'asset', controller: `did:key:${remote.publicKeyMultibase}` } };
    const proof = await celSigner(eventBase);
    expect(proof.cryptosuite).toBe(CEL_CRYPTOSUITE);
    expect(proof.verificationMethod).toBe(remote.verificationMethodId);
    expect((await verifyDidKeyProof(proof, eventBase)).verified).toBe(true);
    expect(remote.signBytesCalls).toBe(1);
  });

  test('throws CEL_ED25519_REQUIRED for a non-Ed25519 signer', async () => {
    const secp = await new KeyManager().generateKeyPair('ES256K');
    expect(() => toCelSigner(signerFromKeyPair(secp))).toThrow(/Ed25519/);
  });

  test('stamps the canonical did:key VM even for an ambient non-did:key identity', async () => {
    const inner = new MockRemoteSigner();
    const foreignVm: OriginalsSigner = {
      verificationMethodId: 'did:webvh:example.com:user#key-1',
      publicKeyMultibase: inner.publicKeyMultibase,
      signBytes: (b) => inner.signBytes(b),
    };
    const proof = await toCelSigner(foreignVm)({ type: 'update', data: { a: 1 } });
    expect(proof.verificationMethod).toBe(canonicalDidKeyVm(inner.publicKeyMultibase));
  });
});

describe('toExternalSigner', () => {
  test('sign() is signingInput.didWebvh + signBytes, by construction', async () => {
    const remote = new MockRemoteSigner();
    const external = toExternalSigner(remote);
    expect(external.getVerificationMethodId()).toBe(remote.verificationMethodId);

    const document = { id: 'did:webvh:example.com:user', value: 42 };
    const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022' };
    const { proofValue } = await external.sign({ document, proof });

    const expectedBytes = await signingInput.didWebvh(document, proof);
    const sig = multikey.decodeMultibase(proofValue);
    const pub = multikey.decodePublicKey(remote.publicKeyMultibase).key;
    expect(ed25519.verify(sig, expectedBytes, pub)).toBe(true);
  });

  test('exposes signBytes for the credential/multisig byte-level path', async () => {
    const remote = new MockRemoteSigner();
    const external = toExternalSigner(remote);
    const msg = new TextEncoder().encode('hash-data');
    const { signature } = await external.signBytes!(msg);
    expect(ed25519.verify(signature, msg, multikey.decodePublicKey(remote.publicKeyMultibase).key)).toBe(true);
  });
});
