/**
 * Tests for opt-in did:webvh pre-rotation key support (#207, DEF-018).
 *
 * Pre-rotation security property: each log entry pre-commits the SHA-256
 * multihash of the *next* update key. A rotation is only valid if the new
 * updateKey's hash was committed in the previous entry's `nextKeyHashes`.
 * This prevents a compromised current key from redirecting the rotation chain
 * to an attacker-controlled key.
 *
 * API contract:
 *   createDIDWebVH({ prerotation: true })  → { keyPair, nextKeyPair }
 *   rotateDIDWebVHKeys({ currentKeyPair: nextKeyPair, prerotation: true })
 *     → { newKeyPair (=currentKeyPair), nextKeyPair (fresh) }
 *   Repeat for subsequent rotations.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { WebVHManager, computeNextKeyHash } from '../../../src/did/WebVHManager';
import { KeyManager } from '../../../src/did/KeyManager';

describe('computeNextKeyHash', () => {
  test('produces a non-empty base58btc string', () => {
    const hash = computeNextKeyHash('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    // Result is plain base58btc (no multibase 'z' prefix), length is ~46 chars for sha2-256 multihash
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(40);
    // Should not have multibase prefix
    expect(hash.startsWith('z')).toBe(false);
  });

  test('produces deterministic output for same input', () => {
    const key = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    expect(computeNextKeyHash(key)).toBe(computeNextKeyHash(key));
  });

  test('produces different hashes for different keys', () => {
    const h1 = computeNextKeyHash('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    const h2 = computeNextKeyHash('did:key:z6MkrphiqmDSy8kQ4M2GfcbgLFD3epDhQzGM3J9mHJJhE5f8');
    expect(h1).not.toBe(h2);
  });
});

describe('WebVHManager — pre-rotation creation', () => {
  let manager: WebVHManager;

  beforeEach(() => {
    manager = new WebVHManager();
  });

  test('createDIDWebVH with prerotation:true returns nextKeyPair', async () => {
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      prerotation: true,
    });

    expect(result.nextKeyPair).toBeDefined();
    expect(result.nextKeyPair!.publicKey).toMatch(/^z/);
    expect(result.nextKeyPair!.privateKey).toMatch(/^z/);
    expect(result.nextKeyPair!.publicKey).not.toBe(result.keyPair.publicKey);
  }, 15000);

  test('createDIDWebVH with prerotation:true stores nextKeyHash in log entry', async () => {
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      prerotation: true,
    });

    const firstEntry = result.log[0];
    const storedHashes = (firstEntry.parameters as { nextKeyHashes?: string[] }).nextKeyHashes;
    expect(Array.isArray(storedHashes)).toBe(true);
    expect(storedHashes!.length).toBe(1);

    // Verify it matches computeNextKeyHash of the returned nextKeyPair
    const expectedHash = computeNextKeyHash(`did:key:${result.nextKeyPair!.publicKey}`);
    expect(storedHashes![0]).toBe(expectedHash);
  }, 15000);

  test('createDIDWebVH without prerotation does not set nextKeyPair (default unchanged)', async () => {
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
    });

    expect(result.nextKeyPair).toBeUndefined();

    const firstEntry = result.log[0];
    const storedHashes = (firstEntry.parameters as { nextKeyHashes?: string[] }).nextKeyHashes;
    // Non-pre-rotation: nextKeyHashes is absent or empty
    expect(!storedHashes || storedHashes.length === 0).toBe(true);
  }, 15000);
});

describe('WebVHManager — pre-rotation key rotation chain', () => {
  let manager: WebVHManager;
  let keyManager: KeyManager;

  beforeEach(() => {
    manager = new WebVHManager();
    keyManager = new KeyManager();
  });

  test('single pre-rotation rotation succeeds and returns nextKeyPair', async () => {
    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      prerotation: true,
    });

    // Rotate using the pre-committed nextKeyPair as currentKeyPair
    const rotated = await manager.rotateDIDWebVHKeys({
      did: created.did,
      currentLog: created.log,
      currentKeyPair: created.nextKeyPair!,
      prerotation: true,
    });

    expect(rotated.log.length).toBe(2);
    expect(rotated.didDocument.id).toBe(created.did);
    // newKeyPair in pre-rotation mode is the key that just became active (=currentKeyPair)
    expect(rotated.newKeyPair.publicKey).toBe(created.nextKeyPair!.publicKey);
    // nextKeyPair is the freshly generated one committed for the NEXT rotation
    expect(rotated.nextKeyPair).toBeDefined();
    expect(rotated.nextKeyPair!.publicKey).not.toBe(created.nextKeyPair!.publicKey);
  }, 20000);

  test('3 sequential pre-rotation rotations produce a log of 4 entries', async () => {
    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      prerotation: true,
    });

    let log = created.log;
    let currentKeyPair = created.nextKeyPair!; // pre-committed key becomes the signer

    for (let i = 0; i < 3; i++) {
      const rotated = await manager.rotateDIDWebVHKeys({
        did: created.did,
        currentLog: log,
        currentKeyPair,
        prerotation: true,
      });
      log = rotated.log;
      currentKeyPair = rotated.nextKeyPair!;
    }

    expect(log.length).toBe(4); // 1 create + 3 rotations
  }, 60000);

  test('each rotation entry commits the next key hash correctly', async () => {
    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      prerotation: true,
    });

    const r1 = await manager.rotateDIDWebVHKeys({
      did: created.did,
      currentLog: created.log,
      currentKeyPair: created.nextKeyPair!,
      prerotation: true,
    });

    // The second log entry should commit r1.nextKeyPair's hash
    const secondEntry = r1.log[1];
    const storedHashes = (secondEntry.parameters as { nextKeyHashes?: string[] }).nextKeyHashes;
    expect(Array.isArray(storedHashes)).toBe(true);
    expect(storedHashes!.length).toBe(1);

    const expectedHash = computeNextKeyHash(`did:key:${r1.nextKeyPair!.publicKey}`);
    expect(storedHashes![0]).toBe(expectedHash);
  }, 20000);

  test('rotation with a non-pre-committed key is rejected by the SDK pre-rotation guard', async () => {
    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      prerotation: true,
    });

    // Generate an entirely different key (not the pre-committed nextKeyPair)
    const rogue = await keyManager.generateKeyPair('Ed25519');

    // Attempting rotation signed by a non-pre-committed key must throw
    await expect(
      manager.rotateDIDWebVHKeys({
        did: created.did,
        currentLog: created.log,
        currentKeyPair: rogue, // wrong key — not the pre-committed one
        prerotation: true,
      })
    ).rejects.toThrow();
  }, 20000);

  test('pre-rotation on an empty DID log is rejected with a clear error', async () => {
    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      prerotation: true,
    });
    // Macroscope #212: passing an empty currentLog must not crash with a
    // TypeError on undefined.parameters — it must throw a clear guard error.
    await expect(
      manager.rotateDIDWebVHKeys({
        did: created.did,
        currentLog: [],
        currentKeyPair: created.nextKeyPair!,
        prerotation: true,
      })
    ).rejects.toThrow('empty DID log');
  }, 20000);

  test('non-pre-rotation default mode still works after the pre-rotation tests', async () => {
    // Regression guard: standard rotation (no prerotation flag) still works unchanged
    const created = await manager.createDIDWebVH({ domain: 'example.com' });
    const r1 = await manager.rotateDIDWebVHKeys({
      did: created.did,
      currentLog: created.log,
      currentKeyPair: created.keyPair,
    });
    const r2 = await manager.rotateDIDWebVHKeys({
      did: created.did,
      currentLog: r1.log,
      currentKeyPair: r1.newKeyPair,
    });
    expect(r2.log.length).toBe(3);
    expect(r2.nextKeyPair).toBeUndefined();
  }, 30000);
});
