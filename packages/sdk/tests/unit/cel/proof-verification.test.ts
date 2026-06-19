/**
 * CEL Proof Verification Tests
 *
 * Verifies that `verifyEventLog` performs real Ed25519 cryptographic verification
 * for `did:key` + `eddsa-jcs-2022` proofs and correctly detects tampering.
 *
 * Test cases:
 *  1. Round-trip: sign → verify passes with cryptographicallyVerified: true
 *  2. Tampered data: mutated event data causes signature failure
 *  3. Tampered signature: corrupted proofValue causes signature failure
 *  4. Wrong key: verificationMethod contains a different public key → fails
 *  5. Non-did:key VM: structural-only path, cryptographicallyVerified: false
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import {
  createEventLog,
  updateEventLog,
  verifyEventLog,
} from '../../../src/cel/algorithms';
import type { DataIntegrityProof, CreateOptions, UpdateOptions, EventLog } from '../../../src/cel/types';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';

// ---------------------------------------------------------------------------
// Key generation helper — mirrors createSigner in src/cel/cli/create.ts
// ---------------------------------------------------------------------------

async function generateEd25519KeyPair(): Promise<{
  privateKeyBytes: Uint8Array;
  publicKeyBytes: Uint8Array;
  publicKeyMultikey: string;
}> {
  const ed25519 = await import('@noble/ed25519');
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  const publicKeyBytes = new Uint8Array(
    await (ed25519 as any).getPublicKeyAsync(privateKeyBytes)
  );
  const publicKeyMultikey = multikey.encodePublicKey(publicKeyBytes, 'Ed25519');
  return { privateKeyBytes, publicKeyBytes, publicKeyMultikey };
}

/**
 * Creates a real Ed25519 signer, exactly like `createSigner` in the CLI.
 * Signs `canonicalizeEvent(data)` and sets `verificationMethod: did:key:<pk>#<pk>`.
 */
async function createRealSigner(privateKeyBytes: Uint8Array, publicKeyMultikey: string) {
  return async (data: unknown): Promise<DataIntegrityProof> => {
    const ed25519 = await import('@noble/ed25519');
    const dataBytes = canonicalizeEvent(data);
    const signature = await (ed25519 as any).signAsync(dataBytes, privateKeyBytes);
    const proofValue = multikey.encodeMultibase(new Uint8Array(signature));
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod: `did:key:${publicKeyMultikey}#${publicKeyMultikey}`,
      proofPurpose: 'assertionMethod',
      proofValue,
    };
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('CEL Proof Verification', () => {
  let keypair: Awaited<ReturnType<typeof generateEd25519KeyPair>>;
  let signer: (data: unknown) => Promise<DataIntegrityProof>;
  let createOpts: CreateOptions;
  let updateOpts: UpdateOptions;

  beforeAll(async () => {
    keypair = await generateEd25519KeyPair();
    signer = await createRealSigner(keypair.privateKeyBytes, keypair.publicKeyMultikey);
    const verificationMethod = `did:key:${keypair.publicKeyMultikey}#${keypair.publicKeyMultikey}`;
    createOpts = { signer, verificationMethod };
    updateOpts = { signer, verificationMethod };
  });

  // -------------------------------------------------------------------------
  // Test 1: Round-trip — sign then verify passes
  // -------------------------------------------------------------------------
  test('1. Round-trip: real sign → verify → verified: true, cryptographicallyVerified: true', async () => {
    const log0 = await createEventLog(
      { name: 'test-asset', layer: 'peer', did: 'did:peer:test' },
      createOpts,
    );
    const log1 = await updateEventLog(log0, { version: 2 }, updateOpts);
    const log2 = await updateEventLog(log1, { version: 3 }, updateOpts);

    const result = await verifyEventLog(log2);

    expect(result.verified).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.events).toHaveLength(3);

    // Every event must be cryptographically verified (not just structural).
    for (const ev of result.events) {
      expect(ev.proofValid).toBe(true);
      expect(ev.chainValid).toBe(true);
      expect(ev.cryptographicallyVerified).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Tampered data — mutating event data breaks the signature
  // -------------------------------------------------------------------------
  test('2. Tampered data: mutated event data → proof verification fails', async () => {
    const log0 = await createEventLog({ name: 'original', value: 42 }, createOpts);
    const log1 = await updateEventLog(log0, { step: 2 }, updateOpts);

    // Deep-clone and mutate a field in event 0's data.
    const tampered: EventLog = JSON.parse(JSON.stringify(log1));
    (tampered.events[0].data as any).value = 999;

    const result = await verifyEventLog(tampered);

    // Signature on event 0 should fail because the data changed.
    expect(result.verified).toBe(false);
    // Event 0 proof is invalid.
    expect(result.events[0].proofValid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3: Tampered signature — corrupted proofValue fails
  // -------------------------------------------------------------------------
  test('3. Tampered signature: corrupted proofValue → proof verification fails', async () => {
    const log = await createEventLog({ name: 'clean' }, createOpts);

    const tampered: EventLog = JSON.parse(JSON.stringify(log));
    // Flip characters in the middle of the base58-encoded signature.
    const original = tampered.events[0].proof[0].proofValue;
    tampered.events[0].proof[0].proofValue =
      original.slice(0, 4) + 'XXXX' + original.slice(8);

    const result = await verifyEventLog(tampered);

    expect(result.verified).toBe(false);
    expect(result.events[0].proofValid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4: Wrong key — verificationMethod contains a different public key
  // -------------------------------------------------------------------------
  test('4. Wrong key: proof signed by key A but VM claims key B → fails', async () => {
    // Generate a second independent keypair (key B).
    const keypairB = await generateEd25519KeyPair();
    const signerB = await createRealSigner(keypairB.privateKeyBytes, keypairB.publicKeyMultikey);
    const createOptsB: CreateOptions = {
      signer: signerB,
      verificationMethod: `did:key:${keypairB.publicKeyMultikey}#${keypairB.publicKeyMultikey}`,
    };

    // Build a log signed by key B.
    const logB = await createEventLog({ name: 'key-b-asset' }, createOptsB);

    // Now swap the verificationMethod to point at key A's public key.
    const tampered: EventLog = JSON.parse(JSON.stringify(logB));
    tampered.events[0].proof[0].verificationMethod =
      `did:key:${keypair.publicKeyMultikey}#${keypair.publicKeyMultikey}`;

    const result = await verifyEventLog(tampered);

    // The signature was made with key B but the VM claims key A — must fail.
    expect(result.verified).toBe(false);
    expect(result.events[0].proofValid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6: did:key with non-Ed25519 key type → fail closed (security)
  // -------------------------------------------------------------------------
  test('6. Non-Ed25519 did:key (ES256K): eddsa-jcs-2022 + secp256k1 VM → verified: false', async () => {
    // Generate a real secp256k1 (ES256K) key pair; its publicKeyMultibase is
    // multikey-encoded with the secp256k1 multicodec prefix, so decodePublicKey
    // returns type === 'Secp256k1', not 'Ed25519'.
    const { KeyManager } = await import('../../../src/did/KeyManager');
    const km = new KeyManager();
    const secp256k1Pair = await km.generateKeyPair('ES256K');
    const nonEd25519Multikey = secp256k1Pair.publicKey; // e.g. "zQ3s..."

    const forgedProof: DataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: new Date().toISOString(),
      verificationMethod: `did:key:${nonEd25519Multikey}#${nonEd25519Multikey}`,
      proofPurpose: 'assertionMethod',
      // Bogus z-prefixed proof value — would pass structural checks but
      // must not pass cryptographic verification.
      proofValue: 'z' + 'A'.repeat(40),
    };

    const forgedLog: EventLog = {
      events: [
        {
          type: 'create',
          data: { x: 1 },
          proof: [forgedProof],
        },
      ],
    };

    const result = await verifyEventLog(forgedLog);

    // Must fail closed: a non-Ed25519 key under eddsa-jcs-2022 is invalid.
    expect(result.verified).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5: Non-did:key VM → structural-only path, cryptographicallyVerified: false
  // -------------------------------------------------------------------------
  test('5. Non-did:key VM: structural path only → cryptographicallyVerified: false, no throw', async () => {
    const structuralOnlyLog: EventLog = {
      events: [
        {
          type: 'create',
          data: { name: 'structural-only-asset' },
          proof: [
            {
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              created: new Date().toISOString(),
              verificationMethod: 'did:webvh:example.com#key-1',
              proofPurpose: 'assertionMethod',
              proofValue: 'zFakeButStructurallyValid123',
            },
          ],
        },
      ],
    };

    const result = await verifyEventLog(structuralOnlyLog);

    // Structural checks pass (valid fields, z-prefix), chain is valid (single event).
    expect(result.verified).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.events[0].proofValid).toBe(true);
    expect(result.events[0].chainValid).toBe(true);
    // But no cryptographic verification was performed.
    expect(result.events[0].cryptographicallyVerified).toBe(false);
  });
});
