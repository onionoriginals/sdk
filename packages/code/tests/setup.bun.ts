// Setup for the @originals/code Bun tests: no network at all (fetch throws, so
// "verifies offline" is a fact of every test, not a mock returning 404), quiet
// console, and a failing run on an escaped promise rejection (plan 046, item 5).
import { afterEach, beforeEach, spyOn, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

let fetchMock: ReturnType<typeof spyOn> | null = null;
const quiet = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };

beforeEach(() => {
  fetchMock = spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch').mockImplementation((async (url: string) => {
    throw new Error(`network disabled in @originals/code tests: ${String(url)}`);
  }) as unknown as typeof fetch);
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  console.warn = () => {};
});

afterEach(() => {
  fetchMock?.mockRestore();
  fetchMock = null;
  Object.assign(console, quiet);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error(`\n=== UNHANDLED REJECTION ===\n${reason instanceof Error ? reason.stack : String(reason)}\n`);
  process.exitCode = 1;
});
