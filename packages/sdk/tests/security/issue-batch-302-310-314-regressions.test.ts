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
 * - #314: CEL witness proofs must be signed over the JSON-quoted digest bytes
 *   the verifier reconstructs; a witness signing the raw decoded digest bytes
 *   must be reported unverified, not silently accepted.
 */

import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { MultiSigManager } from '../../src/vc/MultiSigManager';
import { KeyManager } from '../../src/did/KeyManager';
import { DIDManager } from '../../src/did/DIDManager';
import { multikey } from '../../src/crypto/Multikey';
import { verifyEventLog } from '../../src/cel/algorithms/verifyEventLog';
import {
  canonicalizeEntryForChain,
  witnessSigningBytes,
} from '../../src/cel/canonicalize';
import { computeDigestMultibase, decodeDigestMultibase } from '../../src/cel/hash';
import type { EventLog } from '../../src/cel/types';
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

describe('#314 — witness proofs must sign the digest preimage the verifier reconstructs', () => {
  async function buildLog(witnessSign: (digest: string, key: Uint8Array) => Promise<Uint8Array>) {
    const controllerSk = ed25519.utils.randomSecretKey();
    const controllerPk = new Uint8Array(await (ed25519 as any).getPublicKeyAsync(controllerSk));
    const controllerPub = multikey.encodePublicKey(controllerPk, 'Ed25519');
    const controllerVm = `did:key:${controllerPub}#${controllerPub}`;

    const eventData = { name: 'Attested Asset' };
    // Reproduce the controller-proof signing convention used by the SDK.
    const { canonicalizeEvent } = await import('../../src/cel/canonicalize');
    const controllerSig = await (ed25519 as any).signAsync(
      canonicalizeEvent({ type: 'create', data: eventData }),
      controllerSk,
    );

    const witnessSk = ed25519.utils.randomSecretKey();
    const witnessPk = new Uint8Array(await (ed25519 as any).getPublicKeyAsync(witnessSk));
    const witnessVm = 'did:webvh:witness.example.com#key-ed25519';

    const digest = computeDigestMultibase(canonicalizeEntryForChain({ type: 'create', data: eventData, proof: [] } as any));
    const witnessSig = await witnessSign(digest, witnessSk);

    const log: EventLog = {
      events: [{
        type: 'create',
        data: eventData,
        proof: [
          {
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: '2026-01-20T12:00:00Z',
            verificationMethod: controllerVm,
            proofPurpose: 'assertionMethod',
            proofValue: multikey.encodeMultibase(new Uint8Array(controllerSig)),
          },
          {
            type: 'DataIntegrityProof',
            cryptosuite: 'eddsa-jcs-2022',
            created: '2026-01-20T12:00:00Z',
            verificationMethod: witnessVm,
            proofPurpose: 'assertionMethod',
            proofValue: multikey.encodeMultibase(new Uint8Array(witnessSig)),
            witnessedAt: '2026-01-20T12:00:00Z',
          } as any,
        ],
      }],
    };
    const resolveKey = async (method: string): Promise<Uint8Array | null> =>
      method === witnessVm ? witnessPk : null;
    return { log, resolveKey };
  }

  test('a witness signing the JSON-quoted digest (witnessSigningBytes) is accepted', async () => {
    const { log, resolveKey } = await buildLog(async (digest, key) =>
      new Uint8Array(await (ed25519 as any).signAsync(witnessSigningBytes(digest), key)),
    );
    const result = await verifyEventLog(log, { resolveKey });
    expect(result.events[0].witnessProofs![0].verified).toBe(true);
  });

  test('a witness signing the raw decoded digest bytes is reported unverified', async () => {
    const { log, resolveKey } = await buildLog(async (digest, key) =>
      new Uint8Array(await (ed25519 as any).signAsync(decodeDigestMultibase(digest), key)),
    );
    const result = await verifyEventLog(log, { resolveKey });
    expect(result.events[0].witnessProofs![0].verified).toBe(false);
  });
});
