/**
 * CEL key resolver tests
 *
 * The resolver maps a proof's verificationMethod DID URL to the Ed25519 public
 * key used to verify CEL signatures. It must fail closed (return null) for
 * verification methods that have been revoked or marked compromised, otherwise
 * an attacker holding a retired private key could forge accepted signatures.
 */

import { describe, it, expect } from 'vitest';
import { createDidManagerKeyResolver } from '../../../src/cel/keyResolver';
import { multikey } from '../../../src/crypto/Multikey';
import type { DIDManager } from '../../../src/did/DIDManager';
import type { DIDDocument, VerificationMethod } from '../../../src/types/did';

const DID = 'did:peer:zResolverTest';
const VM_ID = `${DID}#key-1`;

// A deterministic 32-byte Ed25519 public key encoded as multibase Multikey.
const PUBLIC_KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256);
const PUBLIC_KEY_MULTIBASE = multikey.encodePublicKey(PUBLIC_KEY, 'Ed25519');

function makeResolver(vm: VerificationMethod) {
  const doc: DIDDocument = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: DID,
    verificationMethod: [vm]
  };
  const didManager = {
    resolveDID: async (did: string) => (did === DID ? doc : null)
  } as unknown as DIDManager;
  return createDidManagerKeyResolver(didManager);
}

function baseVM(): VerificationMethod {
  return {
    id: VM_ID,
    type: 'Multikey',
    controller: DID,
    publicKeyMultibase: PUBLIC_KEY_MULTIBASE
  };
}

describe('createDidManagerKeyResolver', () => {
  it('resolves the Ed25519 public key for an active verification method', async () => {
    const resolve = makeResolver(baseVM());
    const key = await resolve(VM_ID);
    expect(key).not.toBeNull();
    expect(Array.from(key!)).toEqual(Array.from(PUBLIC_KEY));
  });

  it('returns null for a revoked verification method', async () => {
    const resolve = makeResolver({ ...baseVM(), revoked: '2024-01-01T00:00:00Z' });
    const key = await resolve(VM_ID);
    expect(key).toBeNull();
  });

  it('returns null for a compromised verification method', async () => {
    const resolve = makeResolver({ ...baseVM(), compromised: '2024-01-01T00:00:00Z' });
    const key = await resolve(VM_ID);
    expect(key).toBeNull();
  });
});
