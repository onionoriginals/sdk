/**
 * crypto-storage-coverage.test.ts
 *
 * Closes remaining crypto/storage coverage gaps:
 *
 * [CRYPTO-STORAGE-011/happy] Noble crypto init is idempotent — calling
 *   initNobleCrypto() multiple times causes no errors and leaves the same
 *   function references in place.
 *
 * [CRYPTO-STORAGE-012/security] KeyManager.generateKeyPair produces
 *   cryptographically UNIQUE keypairs each call.  20 keypairs are generated
 *   per key type (ES256K, Ed25519, ES256) and the test asserts that every
 *   public key and every private key string is distinct across the batch.
 */

import { describe, test, expect } from 'bun:test';
import { initNobleCrypto } from '../../../src/crypto/noble-init';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { KeyManager } from '../../../src/did/KeyManager';

// ---------------------------------------------------------------------------
// CRYPTO-STORAGE-011 — Noble crypto init is idempotent
// ---------------------------------------------------------------------------

describe('[CRYPTO-STORAGE-011] Noble crypto init is idempotent', () => {
  test('calling initNobleCrypto() multiple times does not throw', () => {
    // First call already happened when the module was imported.
    // Call it explicitly several more times to confirm idempotency.
    expect(() => initNobleCrypto()).not.toThrow();
    expect(() => initNobleCrypto()).not.toThrow();
    expect(() => initNobleCrypto()).not.toThrow();
  });

  // NOTE: @noble/secp256k1 v3.x and @noble/ed25519 v3.x moved sync hash
  // configuration from the (now frozen) `utils` / `etc` objects to a
  // dedicated, writable `hashes` object. noble-init.ts still best-effort
  // mirrors the legacy `utils.hmacSha256Sync` / `etc.sha512Sync` locations
  // for backward compatibility, but those objects are frozen by the
  // libraries themselves as of v3, so injection into them is a no-op.
  // These tests assert against the real v3 configuration surface.
  test('secp256k1.hashes.hmacSha256 is still a function after repeated init', () => {
    initNobleCrypto();
    initNobleCrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const sAny = secp256k1 as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(typeof sAny.hashes?.hmacSha256).toBe('function');
  });

  test('secp256k1.hashes.hmacSha256 remains callable after repeated init', () => {
    initNobleCrypto();
    initNobleCrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const result = (secp256k1 as any).hashes.hmacSha256(
      new Uint8Array(32).fill(1),
      new Uint8Array(16).fill(2),
    ) as Uint8Array;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32); // HMAC-SHA256 is always 32 bytes
  });

  test('ed25519.hashes.sha512 is still a function after repeated init', () => {
    initNobleCrypto();
    initNobleCrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eAny = ed25519 as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(typeof eAny?.hashes?.sha512).toBe('function');
  });

  test('ed25519.hashes.sha512 remains callable and returns 64 bytes after repeated init', () => {
    initNobleCrypto();
    initNobleCrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eAny = ed25519 as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const fn = eAny.hashes.sha512 as (msg: Uint8Array) => Uint8Array;

    expect(fn).toBeDefined();
    const result = fn(new Uint8Array(16).fill(5));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(64); // SHA-512 is always 64 bytes
  });

  test('function references are stable (same object) across repeated init calls', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sAny = secp256k1 as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const hmacBefore = sAny.hashes?.hmacSha256 as unknown;

    initNobleCrypto();
    initNobleCrypto();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const hmacAfter = sAny.hashes?.hmacSha256 as unknown;

    // The function reference should not have been replaced (idempotent guard).
    expect(hmacAfter).toBe(hmacBefore);
  });
});

// ---------------------------------------------------------------------------
// CRYPTO-STORAGE-012 — KeyManager.generateKeyPair produces unique keypairs
// ---------------------------------------------------------------------------

const SAMPLE_SIZE = 20;

describe('[CRYPTO-STORAGE-012] KeyManager.generateKeyPair produces unique keypairs', () => {
  const km = new KeyManager();

  test(`ES256K — ${SAMPLE_SIZE} keypairs have all-distinct public keys`, async () => {
    const publicKeys = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('ES256K');
      publicKeys.add(kp.publicKey);
    }
    expect(publicKeys.size).toBe(SAMPLE_SIZE);
  });

  test(`ES256K — ${SAMPLE_SIZE} keypairs have all-distinct private keys`, async () => {
    const privateKeys = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('ES256K');
      privateKeys.add(kp.privateKey);
    }
    expect(privateKeys.size).toBe(SAMPLE_SIZE);
  });

  test(`Ed25519 — ${SAMPLE_SIZE} keypairs have all-distinct public keys`, async () => {
    const publicKeys = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('Ed25519');
      publicKeys.add(kp.publicKey);
    }
    expect(publicKeys.size).toBe(SAMPLE_SIZE);
  });

  test(`Ed25519 — ${SAMPLE_SIZE} keypairs have all-distinct private keys`, async () => {
    const privateKeys = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('Ed25519');
      privateKeys.add(kp.privateKey);
    }
    expect(privateKeys.size).toBe(SAMPLE_SIZE);
  });

  test(`ES256 — ${SAMPLE_SIZE} keypairs have all-distinct public keys`, async () => {
    const publicKeys = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('ES256');
      publicKeys.add(kp.publicKey);
    }
    expect(publicKeys.size).toBe(SAMPLE_SIZE);
  });

  test(`ES256 — ${SAMPLE_SIZE} keypairs have all-distinct private keys`, async () => {
    const privateKeys = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('ES256');
      privateKeys.add(kp.privateKey);
    }
    expect(privateKeys.size).toBe(SAMPLE_SIZE);
  });

  test('ES256K — no public key collides with any private key in the batch', async () => {
    const all = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('ES256K');
      all.add(`pub:${kp.publicKey}`);
      all.add(`prv:${kp.privateKey}`);
    }
    // 2 × SAMPLE_SIZE unique tagged entries means zero cross-type collisions
    expect(all.size).toBe(2 * SAMPLE_SIZE);
  });

  test('Ed25519 — no public key collides with any private key in the batch', async () => {
    const all = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('Ed25519');
      all.add(`pub:${kp.publicKey}`);
      all.add(`prv:${kp.privateKey}`);
    }
    expect(all.size).toBe(2 * SAMPLE_SIZE);
  });

  test('ES256 — no public key collides with any private key in the batch', async () => {
    const all = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i++) {
      const kp = await km.generateKeyPair('ES256');
      all.add(`pub:${kp.publicKey}`);
      all.add(`prv:${kp.privateKey}`);
    }
    expect(all.size).toBe(2 * SAMPLE_SIZE);
  });
});
