// Setup file for Bun test environment
import { webcrypto } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import * as secp256k1 from '@noble/secp256k1';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, spyOn, setDefaultTimeout } from 'bun:test';
import { verificationMethodRegistry } from '../src/vc/documentLoader';

// Set default test timeout to 30 seconds
// Individual tests can override this with their own timeout parameter
// E.g., test('slow test', async () => { ... }, 60000);
setDefaultTimeout(30000);

// Suppress console logs during tests to reduce noise
// Only show errors unless explicitly configured otherwise
const originalConsole = {
  log: console.log,
  info: console.info,
  debug: console.debug,
  warn: console.warn,
};

// Track fetch mock for cleanup
let fetchMock: any = null;

beforeEach(() => {
  // Mock fetch to prevent real network calls during tests
  // Individual tests can override this with their own mocks if needed
  fetchMock = spyOn(global as any, 'fetch').mockImplementation(async (url: string) => {
    // Log unmocked fetch calls to help identify tests that need explicit mocking
    if (process.env.DEBUG_FETCH === 'true') {
      console.error(`[TEST WARNING] Unmocked fetch call to: ${url}`);
    }
    // Return 404 by default to fail tests that forget to mock
    return new Response('Not Found - Mock fetch not configured for this URL', { status: 404 });
  });

  // Suppress non-error console output during tests
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  console.warn = () => {};
});

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

// Global cleanup after each test
afterEach(() => {
  // Restore fetch mock
  if (fetchMock) {
    fetchMock.mockRestore();
    fetchMock = null;
  }

  // Restore console methods
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
  console.warn = originalConsole.warn;

  // Clear verification method registry to prevent pollution
  verificationMethodRegistry.clear();
});

