import { installRegtestTools } from './install';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (!!process.env.BITCOIND_BIN !== !!process.env.ORD_BIN) {
  throw new Error('Set both BITCOIND_BIN and ORD_BIN, or neither to use the pinned installer.');
}
const binaries = process.env.BITCOIND_BIN && process.env.ORD_BIN
  ? { BITCOIND_BIN: process.env.BITCOIND_BIN, ORD_BIN: process.env.ORD_BIN }
  : await installRegtestTools();

for (const cwd of ['packages/cel', 'packages/sdk', 'packages/auth']) {
  const build = Bun.spawn([process.execPath, 'run', 'build'], {
    cwd: root + cwd, stdout: 'inherit', stderr: 'inherit',
  });
  if (await build.exited) throw new Error(`Build failed: ${cwd}`);
}

const check = Bun.spawn([process.execPath, 'run', 'typecheck:regtest'], {
  cwd: root + 'apps/landing', stdout: 'inherit', stderr: 'inherit',
});
if (await check.exited) throw new Error('Regtest harness typecheck failed');

if (process.argv.includes('--browser')) {
  const browser = Bun.spawn([process.execPath, 'apps/landing/scripts/regtest-browser.ts'], {
    cwd: root,
    env: { ...process.env, ...binaries },
    stdout: 'inherit', stderr: 'inherit',
  });
  process.exit(await browser.exited);
}

const scenarios = process.env.REGTEST_FAULT
  ? [process.env.REGTEST_FAULT]
  : ['none', 'reveal-rejected', 'commit-response-lost'];
for (const fault of scenarios) {
  const receipt = process.env.REGTEST_RECEIPT?.replace(/\.json$/, '');
  const journey = Bun.spawn([process.execPath, 'apps/landing/scripts/regtest-journey.ts'], {
    cwd: root,
    env: {
      ...process.env, ...binaries, REGTEST_FAULT: fault,
      ...(receipt ? { REGTEST_RECEIPT: `${receipt}-${fault}.json` } : {}),
      ...(process.env.REGTEST_LOGS_DIR ? { REGTEST_LOGS_DIR: `${process.env.REGTEST_LOGS_DIR}/${fault}` } : {}),
    },
    stdout: 'inherit', stderr: 'inherit',
  });
  if (await journey.exited) process.exit(journey.exitCode ?? 1);
}

const capabilityReceipt = process.env.REGTEST_RECEIPT?.replace(/\.json$/, '');
const capability = Bun.spawn([process.execPath, 'apps/landing/scripts/sat-snapshot-no-address.ts'], {
  cwd: root,
  env: {
    ...process.env, ...binaries,
    ...(capabilityReceipt ? { REGTEST_RECEIPT: `${capabilityReceipt}-no-address-index.json` } : {}),
    ...(process.env.REGTEST_LOGS_DIR ? { REGTEST_LOGS_DIR: `${process.env.REGTEST_LOGS_DIR}/no-address-index` } : {}),
  },
  stdout: 'inherit', stderr: 'inherit',
});
if (await capability.exited) process.exit(capability.exitCode ?? 1);

const restartReceipt = process.env.REGTEST_RECEIPT?.replace(/\.json$/, '');
const restart = Bun.spawn([process.execPath, 'scripts/regtest/restart-check.ts'], {
  cwd: root,
  env: {
    ...process.env, ...binaries,
    ...(restartReceipt ? { REGTEST_RECEIPT: `${restartReceipt}-restart.json` } : {}),
    ...(process.env.REGTEST_LOGS_DIR ? { REGTEST_LOGS_DIR: `${process.env.REGTEST_LOGS_DIR}/restart` } : {}),
  },
  stdout: 'inherit', stderr: 'inherit',
});
if (await restart.exited) process.exit(restart.exitCode ?? 1);
