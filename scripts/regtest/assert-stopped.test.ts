import { fileURLToPath } from 'node:url';
import { test, expect } from 'bun:test';

// The root test preload mocks fetch before each test. Exercise the production
// helper in a plain Bun process, where [test] preloads do not apply, without
// restoring global mocks that other SDK tests depend on.
const fixture = new URL('./assert-stopped.fixture.ts', import.meta.url);

for (const scenario of [
  'a listener that never responds cannot count as a stopped endpoint',
  'an HTTP response also fails the stopped-endpoint check',
  'a redirect to a closed port cannot hide a live original endpoint',
]) {
  test(scenario, async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(fixture), scenario], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 5_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }, 10_000);
}
