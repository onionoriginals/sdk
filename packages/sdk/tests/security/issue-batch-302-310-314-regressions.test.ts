/**
 * Security regressions for the 2026-07 review batch:
 *
 * - #310: multi-sig external-signer contributions were signed over JCS bytes
 *   while verification hashes RDFC bytes, so an externally-signed contribution
 *   could never verify — and, framed from the attacker side, a contributor who
 *   controls canonicalization must not be able to smuggle a mismatched-preimage
 *   signature toward the threshold. The SDK now canonicalizes+hashes and the
 *   signer signs those exact bytes (via signBytes); a wrong-preimage signature
 *   is rejected and cannot count.
 */

import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { MultiSigManager } from '../../src/vc/MultiSigManager';
import { KeyManager } from '../../src/did/KeyManager';
import { DIDManager } from '../../src/did/DIDManager';
import { multikey } from '../../src/crypto/Multikey';
import type { ExternalSigner, MultiSigPolicy, VerifiableCredential } from '../../src/types';

const config = { network: 'regtest' as const, defaultKeyType: 'Ed25519' as const };

async function ed25519Signer(privateKeyMultibase: string, vm: string, mode: 'correct' | 'wrong'): Promise<ExternalSigner> {
  return {
    getVerificationMethodId: () => vm,
    sign: async () => { throw new Error('document-level sign() must not be used for multi-sig'); },
    signBytes: async (data: Uint8Array) => {
      const dec = multikey.decodePrivateKey(privateKeyMultibase);
      const key = dec.key.length === 64 ? dec.key.slice(0, 32) : dec.key;
      // 'wrong' models a signer that canonicalizes differently (e.g. JCS) and
      // therefore signs a different preimage than the SDK's RDFC hash.
      const bytes = mode === 'correct' ? data : new TextEncoder().encode('attacker JCS preimage');
      const signature = await (ed25519 as any).signAsync(bytes, key);
      return { signature: new Uint8Array(signature) };
    },
  };
}

describe('#310 — external multi-sig contributions must sign the SDK-canonicalized bytes', () => {
  const km = new KeyManager();

  const baseVC: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer: 'did:peer:issuer',
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:peer:subject',
      resourceId: 'res1',
      resourceType: 'text',
      creator: 'did:peer:issuer',
      createdAt: '2026-01-01T00:00:00Z',
    },
  } as VerifiableCredential;

  test('a wrong-preimage (JCS-style) contribution cannot count toward the threshold', async () => {
    const manager = new MultiSigManager(config, new DIDManager(config));
    const key = await km.generateKeyPair('Ed25519');
    const vm = `did:key:${key.publicKey}#${key.publicKey}`;
    const policy: MultiSigPolicy = { required: 1, total: 1, signerVerificationMethods: [vm] };

    const signed = await manager.signCredentialMultiSig(baseVC, {
      policy,
      externalSigners: new Map([[vm, await ed25519Signer(key.privateKey, vm, 'wrong')]]),
    });
    const result = await manager.verifyMultiSig(signed, policy);
    expect(result.verified).toBe(false);
    expect(result.validSignatures).toBe(0);
  });

  test('a correctly (signBytes) signed contribution verifies and meets the threshold', async () => {
    const manager = new MultiSigManager(config, new DIDManager(config));
    const key = await km.generateKeyPair('Ed25519');
    const vm = `did:key:${key.publicKey}#${key.publicKey}`;
    const policy: MultiSigPolicy = { required: 1, total: 1, signerVerificationMethods: [vm] };

    const signed = await manager.signCredentialMultiSig(baseVC, {
      policy,
      externalSigners: new Map([[vm, await ed25519Signer(key.privateKey, vm, 'correct')]]),
    });
    const result = await manager.verifyMultiSig(signed, policy);
    expect(result.verified).toBe(true);
    expect(result.validSignatures).toBe(1);
  });
});
