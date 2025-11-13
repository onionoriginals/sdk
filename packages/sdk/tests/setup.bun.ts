// Setup file for Bun test environment
import { webcrypto } from 'node:crypto';
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

// Initialize noble crypto libraries (uses shared initialization module)
// This ensures libraries are configured before any tests run
import '../src/crypto/noble-init.js';

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

