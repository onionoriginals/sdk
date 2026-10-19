import { installRegtestTools } from './install';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (!!process.env.BITCOIND_BIN !== !!process.env.ORD_BIN) {
  throw new Error('Set both BITCOIND_BIN and ORD_BIN, or neither to use the pinned installer.');
}
const binaries = process.env.BITCOIND_BIN && process.env.ORD_BIN
  ? { BITCOIND_BIN: process.env.BITCOIND_BIN, ORD_BIN: process.env.ORD_BIN }
  : await installRegtestTools();

for (const cwd of ['packages/vh', 'packages/sdk', 'packages/auth']) {
  const build = Bun.spawn([process.execPath, 'run', 'build'], {
    cwd: root + cwd, stdout: 'inherit', stderr: 'inherit',
  });
  if (await build.exited) throw new Error(`Build failed: ${cwd}`);
}

const transport = Bun.spawn(['node', '--test', 'scripts/chain-validator-node.test.mjs'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
if (await transport.exited) throw new Error('Node Core authentication check failed');

const check = Bun.spawn([process.execPath, 'run', 'typecheck:regtest'], {
  cwd: root + 'apps/landing', stdout: 'inherit', stderr: 'inherit',
});
if (await check.exited) throw new Error('Regtest harness typecheck failed');

// The creator journey (create, publish, inscribe, fault recovery) and its
// browser variant ran the CEL 3 flow, which plan 011 PR 5 deleted. They return
// with Bitcoin anchoring on the Originals Protocol (PR 10). Until then this
// runs the generic Core/ord checks below.
if (process.argv.includes('--browser')) {
  console.log('regtest: the browser creator journey returns with Bitcoin anchoring (plan 011, PR 10); nothing to run.');
  process.exit(0);
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
