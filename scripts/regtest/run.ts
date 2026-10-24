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

// The CEL 3 creator journey and its browser variant were deleted with plan 011
// PR 5. The landing's anchoring path now runs below (landing-anchor.ts) with the
// landing's engine in this process; a real browser with a live Turnkey session
// is #975's stage A (docs/regtest/originals-live-acceptance.md), owner-run.
if (process.argv.includes('--browser')) {
  console.log('regtest: the real-browser journey with live Turnkey signing is #975 stage A, run by the owner (docs/regtest/originals-live-acceptance.md); nothing to run here.');
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

// Anchored Originals end to end (plan 011 PR 10): anchor, reinscribe, reorg, crash and resume.
const originals = Bun.spawn([process.execPath, 'scripts/regtest/originals-anchor.ts'], {
  cwd: root,
  env: {
    ...process.env, ...binaries,
    ...(restartReceipt ? { ORIGINALS_REGTEST_EVIDENCE: `${restartReceipt}-originals.json` } : {}),
    ...(process.env.REGTEST_LOGS_DIR ? { ORIGINALS_REGTEST_LOGS: `${process.env.REGTEST_LOGS_DIR}/originals` } : {}),
  },
  stdout: 'inherit', stderr: 'inherit',
});
if (await originals.exited) process.exit(originals.exitCode ?? 1);

// The Bitcoin writer across a real process kill (#975): durable stores, SIGKILL
// between commit and reveal, identical-pair recovery in a fresh process, and a
// fresh reader with only public inputs.
const originalsRestart = Bun.spawn([process.execPath, 'scripts/regtest/originals-restart.ts'], {
  cwd: root,
  env: {
    ...process.env, ...binaries,
    ...(restartReceipt && !process.env.ORIGINALS_REGTEST_RESTART_EVIDENCE ? { ORIGINALS_REGTEST_RESTART_EVIDENCE: `${restartReceipt}-originals-restart.json` } : {}),
    ...(process.env.REGTEST_LOGS_DIR ? { ORIGINALS_REGTEST_LOGS: `${process.env.REGTEST_LOGS_DIR}/originals-restart` } : {}),
  },
  stdout: 'inherit', stderr: 'inherit',
});
if (await originalsRestart.exited) process.exit(originalsRestart.exitCode ?? 1);

// The landing's anchoring path (plan 011 PR 10b, #975): apps/landing/serve.ts with
// ORIGINALS_BITCOIN_ANCHORING=1 and the landing's own engine over HTTP; anchor,
// reinscribe the Original's own sat, the server killed between commit and reveal
// and a fresh one resuming the identical pair, a reorg, a fresh reader. Local
// keys stand in for Turnkey and say so in the receipt.
const landingAnchor = Bun.spawn([process.execPath, 'scripts/regtest/landing-anchor.ts'], {
  cwd: root,
  env: {
    ...process.env, ...binaries,
    ...(restartReceipt && !process.env.ORIGINALS_REGTEST_LANDING_EVIDENCE ? { ORIGINALS_REGTEST_LANDING_EVIDENCE: `${restartReceipt}-landing-anchor.json` } : {}),
    ...(process.env.REGTEST_LOGS_DIR ? { ORIGINALS_REGTEST_LOGS: `${process.env.REGTEST_LOGS_DIR}/landing-anchor` } : {}),
  },
  stdout: 'inherit', stderr: 'inherit',
});
if (await landingAnchor.exited) process.exit(landingAnchor.exitCode ?? 1);
