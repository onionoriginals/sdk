/**
 * assertSignerConformance (plan 040) — the published harness a custody backend
 * runs against its OriginalsSigner. Each contract violation must fail with a
 * SIGNER_NONCONFORMANT error naming the violated check.
 */

import { describe, test, expect } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { assertSignerConformance } from '../../../src/crypto/signerConformance';
import { MockRemoteSigner } from '../../../src/crypto/MockRemoteSigner';
import { signerFromKeyPair } from '../../../src/crypto/OriginalsSigner';
import { KeyManager } from '../../../src/did/KeyManager';
import { multikey } from '../../../src/crypto/Multikey';
import { sha256Bytes } from '../../../src/utils/hash';
import { StructuredError } from '../../../src/utils/telemetry';
import type { OriginalsSigner } from '../../../src/crypto/OriginalsSigner';

async function expectNonconformant(signer: OriginalsSigner, pattern: RegExp) {
  try {
    await assertSignerConformance(signer);
    throw new Error('expected SIGNER_NONCONFORMANT');
  } catch (e) {
    expect(e).toBeInstanceOf(StructuredError);
    expect((e as StructuredError).code).toBe('SIGNER_NONCONFORMANT');
    expect((e as Error).message).toMatch(pattern);
  }
}

describe('assertSignerConformance', () => {
  test('MockRemoteSigner (signBytes-only custody) is conformant', async () => {
    await assertSignerConformance(new MockRemoteSigner());
  });

  test('every key type from signerFromKeyPair is conformant', async () => {
    const km = new KeyManager();
    for (const type of ['Ed25519', 'ES256K', 'ES256'] as const) {
      await assertSignerConformance(signerFromKeyPair(await km.generateKeyPair(type)));
    }
  });

  test('rejects a relative (fragment-less) verificationMethodId', async () => {
    const good = new MockRemoteSigner();
    await expectNonconformant(
      { ...asPlain(good), verificationMethodId: `did:key:${good.publicKeyMultibase}` },
      /absolute/
    );
  });

  test('rejects a non-DID verificationMethodId', async () => {
    const good = new MockRemoteSigner();
    await expectNonconformant(
      { ...asPlain(good), verificationMethodId: 'urn:not-a-did#key' },
      /DID URL/
    );
  });

  test('rejects an undecodable publicKeyMultibase', async () => {
    const good = new MockRemoteSigner();
    await expectNonconformant(
      { ...asPlain(good), publicKeyMultibase: 'zNotAKey' },
      /does not decode/
    );
  });

  test('rejects a wrong-length signature', async () => {
    const good = new MockRemoteSigner();
    await expectNonconformant(
      { ...asPlain(good), signBytes: async () => new Uint8Array(32) },
      /64 bytes/
    );
  });

  test('rejects a non-Uint8Array signBytes result', async () => {
    const good = new MockRemoteSigner();
    await expectNonconformant(
      { ...asPlain(good), signBytes: (async () => 'zSig') as unknown as OriginalsSigner['signBytes'] },
      /Uint8Array/
    );
  });

  test('rejects a signer whose key does not match its signatures', async () => {
    const a = new MockRemoteSigner();
    const b = new MockRemoteSigner();
    // Signs with a's key but claims b's public key.
    await expectNonconformant(
      { verificationMethodId: b.verificationMethodId, publicKeyMultibase: b.publicKeyMultibase, signBytes: (x) => a.signBytes(x) },
      /does not verify/
    );
  });

  test('rejects a signer that hashes or canonicalizes before signing', async () => {
    const secret = ed25519.utils.randomSecretKey();
    const pub = multikey.encodePublicKey(ed25519.getPublicKey(secret), 'Ed25519');
    // The classic remote-custody mistake: sign sha256(bytes) instead of bytes.
    const hashingSigner: OriginalsSigner = {
      verificationMethodId: `did:key:${pub}#${pub}`,
      publicKeyMultibase: pub,
      signBytes: async (bytes) => ed25519.sign(await sha256Bytes(bytes), secret),
    };
    await expectNonconformant(hashingSigner, /EXACTLY/);
  });

  test('rejects an input-ignoring (fixed-message) signer', async () => {
    const secret = ed25519.utils.randomSecretKey();
    const pub = multikey.encodePublicKey(ed25519.getPublicKey(secret), 'Ed25519');
    const probe1 = new TextEncoder().encode('originals-signer-conformance-probe-1');
    const fixed: OriginalsSigner = {
      verificationMethodId: `did:key:${pub}#${pub}`,
      publicKeyMultibase: pub,
      // Always signs probe-1 regardless of input.
      signBytes: async () => ed25519.sign(probe1, secret),
    };
    await expectNonconformant(fixed, /ignoring its input/);
  });
});

/** Spread helper: MockRemoteSigner's method must stay bound to its instance. */
function asPlain(s: MockRemoteSigner): OriginalsSigner {
  return {
    verificationMethodId: s.verificationMethodId,
    publicKeyMultibase: s.publicKeyMultibase,
    signBytes: (b) => s.signBytes(b),
  };
}
