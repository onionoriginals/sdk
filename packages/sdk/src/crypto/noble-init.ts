/**
 * Noble Crypto Library Initialization
 *
 * @noble/ed25519 v3.x and @noble/secp256k1 v3.x require manual configuration of
 * synchronous hash functions via the `hashes` object (async variants such as
 * `sha512Async`/`sha256Async` ship built-in, but sync APIs like `getPublicKey`,
 * `sign`, and `verify` need `hashes.sha512` / `hashes.sha256` / `hashes.hmacSha256`
 * set explicitly). This is by design - they don't bundle sync hash implementations
 * to allow flexibility and keep bundle size small.
 *
 * This module centralizes the initialization to ensure:
 * 1. Libraries are configured before any crypto operations
 * 2. Configuration is consistent across the SDK
 * 3. Readonly property issues (Bun) are handled gracefully
 *
 * This should be imported at the SDK entry point (index.ts) to ensure it runs first.
 */

import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes } from '@noble/hashes/utils.js';

// Implementation functions
//
// IMPORTANT: `hashes.sha256` / `hashes.sha512` are called by the noble libraries
// as `fn(message)` (a single already-assembled Uint8Array), sometimes invoked as
// `fn(message, undefined)` internally. They must NOT be variadic wrappers around
// concatBytes - passing an `undefined` second argument through concatBytes throws
// ("expected Uint8Array, got type=undefined"). Only `hashes.hmacSha256` takes a
// fixed (key, msg) shape.
const sha512Impl = (msg: Uint8Array) => sha512(msg);
const sha256Impl = (msg: Uint8Array) => sha256(msg);
const hmacSha256Impl = (key: Uint8Array, ...msgs: Uint8Array[]) =>
  hmac(sha256, key, concatBytes(...msgs));

/**
 * Safely set a property on an object, handling readonly properties
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeSetProperty(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  obj: any,
  prop: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any,
  options?: { writable?: boolean; configurable?: boolean }
): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    obj[prop] = value;
    return true;
  } catch {
    // Property might be readonly, try defineProperty
    try {
      Object.defineProperty(obj, prop, {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        value,
        writable: options?.writable ?? true,
        configurable: options?.configurable ?? true,
      });
      return true;
    } catch {
      // If both fail, property might already be set or truly readonly
      return false;
    }
  }
}

/**
 * Initialize @noble/secp256k1 with sync hash utilities (v3.x `hashes` object).
 *
 * Note: v3.x freezes the legacy v2.x `utils` object, so it is no longer
 * possible (nor necessary) to inject `utils.hmacSha256Sync` for backward
 * compatibility - all sync signing/verification now reads from `hashes`.
 */
function initSecp256k1(): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
  const sAny: any = secp256k1 as any;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (!sAny?.hashes) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      sAny.hashes = {};
    } catch {
      Object.defineProperty(sAny, 'hashes', {
        value: {},
        writable: true,
        configurable: true,
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (typeof sAny.hashes.sha256 !== 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    safeSetProperty(sAny.hashes, 'sha256', sha256Impl);
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (typeof sAny.hashes.hmacSha256 !== 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    safeSetProperty(sAny.hashes, 'hmacSha256', hmacSha256Impl);
  }
}

/**
 * Initialize @noble/ed25519 with sync sha512 utility (v3.x `hashes.sha512`).
 *
 * Note: v3.x freezes the legacy v2.x `utils` / `etc` objects, so it is no
 * longer possible (nor necessary) to inject `utils.sha512Sync` /
 * `etc.sha512Sync` for backward compatibility - all sync signing/verification
 * now reads from `hashes`.
 */
function initEd25519(): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
  const eAny: any = ed25519 as any;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (!eAny?.hashes) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      eAny.hashes = {};
    } catch {
      Object.defineProperty(eAny, 'hashes', {
        value: {},
        writable: true,
        configurable: true,
      });
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (typeof eAny.hashes.sha512 !== 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    safeSetProperty(eAny.hashes, 'sha512', sha512Impl);
  }
}

/**
 * Initialize all noble crypto libraries
 * This should be called once at SDK startup
 */
export function initNobleCrypto(): void {
  initSecp256k1();
  initEd25519();
}

// Auto-initialize when this module is imported
initNobleCrypto();

