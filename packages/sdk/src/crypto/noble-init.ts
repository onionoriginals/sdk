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
 * 4. It never throws at import time — under some browser ESM bundlers the noble
 *    module namespace is frozen (non-configurable, `hashes` reads undefined), so
 *    configuration is impossible; we warn and skip rather than crash every
 *    consumer that merely imports the SDK (browser white-screen reports).
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
 * Safely set a property on an object, handling readonly properties.
 * Never throws — returns false if the property cannot be set.
 */

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
 * Return the module's mutable `hashes` object, creating it if absent.
 *
 * Returns `null` when the module namespace is frozen and `hashes` cannot be
 * attached — e.g. a strict-ESM browser bundle where the namespace is
 * non-extensible and `hashes` exists only as a non-configurable binding whose
 * value is `undefined`. In that case configuration is impossible and callers
 * must skip rather than dereference `hashes` (which would throw and, at import
 * time, white-screen the consuming app).
 */
function ensureHashesObject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mod: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (mod && typeof mod.hashes === 'object' && mod.hashes !== null) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return mod.hashes;
  }
  // safeSetProperty never throws (frozen namespace → both assign and
  // defineProperty are caught), so this is safe at import time.
  safeSetProperty(mod, 'hashes', {});
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mod && typeof mod.hashes === 'object' && mod.hashes !== null ? mod.hashes : null;
}

// Per-library so a frozen ed25519 namespace still warns even after secp256k1
// already warned (both are frozen together in the Vite pre-bundle scenario).
const warnedFrozen = new Set<string>();
function warnFrozen(lib: string): void {
  if (warnedFrozen.has(lib)) return;
  warnedFrozen.add(lib);
  console.warn(
    `[noble-init] Could not configure @noble/${lib} sync hashes: the module namespace is frozen ` +
      `(non-configurable). Sync crypto ops may be unavailable in this environment. This is usually a ` +
      `bundler dedupe/pre-bundle issue — ensure a single @noble instance is served as ESM.`
  );
}

/**
 * Initialize @noble/secp256k1 with sync hash utilities (v3.x `hashes` object).
 *
 * The optional `mod` parameter exists for testing (inject a frozen/mutable mock);
 * production always configures the real imported module.
 */
export function initSecp256k1(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mod: any = secp256k1
): void {
  const hashes = ensureHashesObject(mod);
  if (!hashes) {
    warnFrozen('secp256k1');
    return;
  }
  if (typeof hashes.sha256 !== 'function') {
    safeSetProperty(hashes, 'sha256', sha256Impl);
  }
  if (typeof hashes.hmacSha256 !== 'function') {
    safeSetProperty(hashes, 'hmacSha256', hmacSha256Impl);
  }
}

/**
 * Initialize @noble/ed25519 with sync sha512 utility (v3.x `hashes.sha512`).
 *
 * The optional `mod` parameter exists for testing (inject a frozen/mutable mock);
 * production always configures the real imported module.
 */
export function initEd25519(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mod: any = ed25519
): void {
  const hashes = ensureHashesObject(mod);
  if (!hashes) {
    warnFrozen('ed25519');
    return;
  }
  if (typeof hashes.sha512 !== 'function') {
    safeSetProperty(hashes, 'sha512', sha512Impl);
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
