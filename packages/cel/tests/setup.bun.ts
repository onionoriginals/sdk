// Setup file for Bun test environment (mirrors the SDK's, minus SDK-only
// concerns: no jsonld documentLoader registry, no noble sync-hash init —
// the CEL core only uses async/self-hashing noble APIs).
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, spyOn, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30000);

const originalConsole = {
  log: console.log,
  info: console.info,
  debug: console.debug,
  warn: console.warn,
};

let fetchMock: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  // Mock fetch to prevent real network calls; tests override with their own mocks.
  fetchMock = spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch').mockImplementation((async (url: string) => {
    if (process.env.DEBUG_FETCH === 'true') {
      console.error(`[TEST WARNING] Unmocked fetch call to: ${url}`);
    }
    return new Response('Not Found - Mock fetch not configured for this URL', { status: 404 });
  }) as unknown as typeof fetch);

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

afterEach(() => {
  if (fetchMock) {
    fetchMock.mockRestore();
    fetchMock = null;
  }
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.debug = originalConsole.debug;
  console.warn = originalConsole.warn;
});
