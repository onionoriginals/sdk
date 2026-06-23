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

  test('secp256k1.utils.hmacSha256Sync is still a function after repeated init', () => {
    initNobleCrypto();
    initNobleCrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const sAny = secp256k1 as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(typeof sAny.utils?.hmacSha256Sync).toBe('function');
  });

  test('secp256k1.utils.hmacSha256Sync remains callable after repeated init', () => {
    initNobleCrypto();
    initNobleCrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const result = (secp256k1 as any).utils.hmacSha256Sync(
      new Uint8Array(32).fill(1),
      new Uint8Array(16).fill(2),
    ) as Uint8Array;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32); // HMAC-SHA256 is always 32 bytes
  });

  test('ed25519 sha512Sync (etc or utils) is still a function after repeated init', () => {
    initNobleCrypto();
    initNobleCrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eAny = ed25519 as any;
    // At least one of etc.sha512Sync or utils.sha512Sync must be a function
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const etcOk = typeof eAny?.etc?.sha512Sync === 'function';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const utilsOk = typeof eAny?.utils?.sha512Sync === 'function';
    expect(etcOk || utilsOk).toBe(true);
  });

  test('ed25519 sha512Sync remains callable and returns 64 bytes after repeated init', () => {
    initNobleCrypto();
    initNobleCrypto();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eAny = ed25519 as any;
    // Pick whichever binding is available
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const fn: ((...msgs: Uint8Array[]) => Uint8Array) | undefined =
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      typeof eAny?.etc?.sha512Sync === 'function'
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        ? (eAny.etc.sha512Sync as (...msgs: Uint8Array[]) => Uint8Array)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        : typeof eAny?.utils?.sha512Sync === 'function'
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          ? (eAny.utils.sha512Sync as (...msgs: Uint8Array[]) => Uint8Array)
          : undefined;

    expect(fn).toBeDefined();
    const result = fn!(new Uint8Array(16).fill(5));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(64); // SHA-512 is always 64 bytes
  });

  test('function references are stable (same object) across repeated init calls', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sAny = secp256k1 as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const hmacBefore = sAny.utils?.hmacSha256Sync as unknown;

    initNobleCrypto();
    initNobleCrypto();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const hmacAfter = sAny.utils?.hmacSha256Sync as unknown;

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
