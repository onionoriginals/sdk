// Production-bundle boot check: load the built page in headless Chromium and
// fail unless #root renders with no uncaught error and no console error.
//
// Guards against the class of bug where the production chunks evaluate in the
// wrong order (for example a chunk import cycle leaving a base class undefined:
// "Class extends value undefined"). That blanks the whole page while the HTML
// and the entry chunk still return 200, and no unit test or typecheck sees it.
//
// Usage:
//   node scripts/boot.mjs          serve ./dist with `vite preview` and check it
//   node scripts/boot.mjs <url>    check an already running server
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { chromiumExecutablePath } from './browser.mjs';

let url = process.argv[2];
let server;
const stopServer = () => {
  if (server && server.exitCode === null) server.kill('SIGTERM');
};
process.on('exit', stopServer);

if (!url) {
  const appDir = fileURLToPath(new URL('..', import.meta.url));
  const require = createRequire(import.meta.url);
  const viteBin = join(dirname(require.resolve('vite/package.json', { paths: [appDir] })), 'bin/vite.js');
  const port = Number(process.env.LANDING_BOOT_PORT ?? 4174);
  url = `http://localhost:${port}/`;
  server = spawn(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'inherit', 'inherit']
  });
  let ready = false;
  for (let i = 0; i < 60 && !ready && server.exitCode === null; i++) {
    ready = await fetch(url).then((r) => r.ok, () => false);
    if (!ready) await sleep(500);
  }
  if (!ready) {
    console.error('[boot] FAILED: preview server never became ready (did you build dist?)');
    process.exit(1);
  }
}

const browser = await chromium.launch({ executablePath: chromiumExecutablePath() });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  // `vite preview` has no API server behind /api, so those requests fail by
  // design. Any other failed resource (a missing chunk) still counts.
  const apiMiss =
    msg.text().startsWith('Failed to load resource') &&
    new URL(msg.location().url || url, url).pathname.startsWith('/api/');
  if (!apiMiss) errors.push(`console: ${msg.text()}`);
});

await page.goto(url, { waitUntil: 'load' });
const rendered = await page
  .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, { timeout: 15000 })
  .then(() => true, () => false);
// Let lazily imported chunks settle so their evaluation errors surface too.
await page.waitForLoadState('networkidle').catch(() => {});
await browser.close();
stopServer();

console.log(`[boot] ${url} #root rendered: ${rendered}`);
console.log(`[boot] errors: ${errors.length ? '\n' + errors.join('\n') : '(none)'}`);
if (!rendered || errors.length) process.exit(1);
