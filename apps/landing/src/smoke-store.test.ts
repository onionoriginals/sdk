import { expect, test } from 'bun:test';

// A plain `new DemoEngine()` keeps its work in this browser's guest database
// (#992). The mock-build smoke run is not a guest's work, so its engine gets a
// MemoryStore of its own and nothing lands in the guest library. The smoke run
// only executes in a browser, so this asserts the construction in the source,
// as demo-tier-honesty.test.ts does for placement.
test('the smoke engine keeps its Originals in a MemoryStore, never the guest library', async () => {
  const source = await Bun.file(new URL('./App.tsx', import.meta.url)).text();
  expect(source).toContain('new DemoEngine({ store: new SmokeStore() })');
  expect(source).not.toMatch(/new DemoEngine\(\s*\)/);
});
