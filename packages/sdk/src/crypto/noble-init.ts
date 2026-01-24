/**
 * Noble Crypto Library Initialization
 * 
 * @noble/ed25519 v2.x and @noble/secp256k1 require manual configuration of hash functions.
 * This is by design - they don't bundle hash implementations to allow flexibility.
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
const sha512Impl = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));
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
 * Initialize @noble/secp256k1 with hmacSha256Sync utility
 */
function initSecp256k1(): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
  const sAny: any = secp256k1 as any;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (!sAny?.utils) {
    // Try to create utils object if it doesn't exist
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      sAny.utils = {};
    } catch {
      // If we can't create it, try defineProperty
      Object.defineProperty(sAny, 'utils', {
        value: {},
        writable: true,
        configurable: true,
      });
    }
  }

  // Set hmacSha256Sync if not already set
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (typeof sAny.utils.hmacSha256Sync !== 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    safeSetProperty(sAny.utils, 'hmacSha256Sync', hmacSha256Impl);
  }
}

/**
 * Initialize @noble/ed25519 with sha512Sync utility
 * Handles both etc.sha512Sync (v2.x) and utils.sha512Sync (backward compat)
 */
function initEd25519(): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
  const eAny: any = ed25519 as any;

  // Set etc.sha512Sync for @noble/ed25519 v2.x (required)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (eAny?.etc && typeof eAny.etc.sha512Sync !== 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    safeSetProperty(eAny.etc, 'sha512Sync', sha512Impl);
  }

  // Set utils.sha512Sync for backward compatibility
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (!eAny?.utils) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      eAny.utils = {};
    } catch {
      Object.defineProperty(eAny, 'utils', {
        value: {},
        writable: true,
        configurable: true,
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (typeof eAny.utils.sha512Sync !== 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    safeSetProperty(eAny.utils, 'sha512Sync', sha512Impl);
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

