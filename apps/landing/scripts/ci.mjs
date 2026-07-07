// CI gate for the landing page (issue #330): build workspace packages,
// build the landing app, serve the production bundle, and run the browser
// smoke test — the full real-SDK lifecycle in headless Chromium, failing on
// any console error or pageerror.
//
// One command from anywhere in the repo:
//   bun apps/landing/scripts/ci.mjs        (or `bun run landing:ci` at root)
//
// Chromium resolution (scripts/browser.mjs): CHROMIUM_PATH env override →
// /opt/pw-browsers/chromium (managed containers) → playwright-core's own
// registry (populate on fresh CI runners with
// `bunx playwright-core install --with-deps chromium`).
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const require = createRequire(import.meta.url);
// vite's exports map hides bin/vite.js from resolvers; go via package.json.
const viteBin = join(
  dirname(require.resolve('vite/package.json', { paths: [appDir] })),
  'bin/vite.js'
);

function run(label, cmd, args, opts = {}) {
  console.log(`\n[landing-ci] ${label}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    console.error(`[landing-ci] FAILED: ${label}`);
    process.exit(res.status ?? 1);
  }
}

// Workspace packages first — the landing app bundles @originals/sdk from its
// dist. Turbo caches this, so it is near-free when nothing changed.
run('build workspace packages', 'bun', ['run', 'build'], { cwd: repoRoot });
run('build landing app', process.execPath, [viteBin, 'build'], { cwd: appDir });

const port = Number(process.env.LANDING_CI_PORT ?? 4173);
console.log(`\n[landing-ci] serve dist on :${port} and run browser smoke test`);
const server = spawn(
  process.execPath,
  [viteBin, 'preview', '--port', String(port), '--strictPort'],
  { cwd: appDir, stdio: ['ignore', 'inherit', 'inherit'] }
);
const stopServer = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('exit', stopServer);

const base = `http://localhost:${port}/`;
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  if (server.exitCode !== null) break;
  ready = await fetch(base).then((r) => r.ok, () => false);
  if (!ready) await sleep(500);
}
if (!ready) {
  console.error('[landing-ci] FAILED: preview server never became ready');
  stopServer();
  process.exit(1);
}

const smoke = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('./smoke.mjs', import.meta.url)), `${base}?smoke=1`],
  { cwd: appDir, stdio: 'inherit' }
);
stopServer();
if (smoke.status !== 0) {
  console.error('[landing-ci] FAILED: smoke test');
  process.exit(smoke.status ?? 1);
}
console.log('\n[landing-ci] PASS — build clean, lifecycle ran, zero console errors');
