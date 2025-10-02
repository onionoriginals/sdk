// Setup file for Bun test environment
import { webcrypto } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import * as secp256k1 from '@noble/secp256k1';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { afterEach } from 'bun:test';
import { verificationMethodRegistry } from '../src/vc/documentLoader';

// Ensure globalThis.crypto is available for noble libraries
if (typeof globalThis.crypto === 'undefined') {
  // @ts-ignore
  globalThis.crypto = webcrypto as unknown as Crypto;
}

// Configure noble libraries properly - use @noble/hashes for consistency
const sha512Impl = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));
const hmacSha256Impl = (key: Uint8Array, ...msgs: Uint8Array[]) => hmac(sha256, key, concatBytes(...msgs));

// @ts-ignore - Set etc.sha512Sync for @noble/ed25519 
ed25519.etc.sha512Sync = sha512Impl;

// Ensure utils object exists before setting functions
const ed25519Any = ed25519 as any;
if (!ed25519Any.utils) ed25519Any.utils = {};
ed25519Any.utils.sha512Sync = sha512Impl;

const secp256k1Any = secp256k1 as any;
if (!secp256k1Any.utils) secp256k1Any.utils = {};
secp256k1Any.utils.hmacSha256Sync = hmacSha256Impl;

// Global cleanup: Clear verification method registry after each test to prevent pollution
afterEach(() => {
  verificationMethodRegistry.clear();
});

