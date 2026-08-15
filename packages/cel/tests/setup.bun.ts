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

// An unhandled rejection makes `bun test` exit non-zero while every suite still
// reports `0 fail` — the process dies after the summary, so CI shows a red X
// with nothing to point at. That has now happened on three PRs, including a
// docs-only one (plan 046, item 5).
//
// This does NOT swallow the rejection: it prints the stack and the test that
// was running when it escaped, so the next occurrence identifies itself instead
// of costing another investigation. A provenance SDK quietly discarding a
// rejected promise is precisely the bug class this suite exists to catch.
process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason.stack : String(reason);
  console.error(
    '\n=== UNHANDLED REJECTION (this is why the run exits non-zero) ===\n' +
      `${err}\n` +
      '=== A promise escaped a test lifecycle. Await it, or catch it. ===\n'
  );
});
