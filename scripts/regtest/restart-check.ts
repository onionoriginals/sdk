import { assertEndpointStopped } from './assert-stopped';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startRegtest, type RegtestRestartTarget } from './environment';
import { installRegtestTools } from './install';

// A separate real-node proof: no SDK build, public wallet, or explorer needed.
if (!!process.env.BITCOIND_BIN !== !!process.env.ORD_BIN) {
  throw new Error('Set both BITCOIND_BIN and ORD_BIN, or neither to use the pinned installer.');
}
const binaries = process.env.BITCOIND_BIN && process.env.ORD_BIN
  ? { BITCOIND_BIN: process.env.BITCOIND_BIN, ORD_BIN: process.env.ORD_BIN }
  : await installRegtestTools();
const controlDir = await mkdtemp(join(tmpdir(), 'originals-regtest-restart-control-'));
const failureFlag = join(controlDir, 'fail-core-start');
const wrapper = join(controlDir, 'bitcoind');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(wrapper, `#!/bin/sh\nif [ -f ${quote(failureFlag)} ]; then echo 'Intentional local Core restart failure' >&2; exit 73; fi\nexec ${quote(binaries.BITCOIND_BIN)} "$@"\n`, { mode: 0o700 });
const priorCore = process.env.BITCOIND_BIN;
const priorOrd = process.env.ORD_BIN;
process.env.BITCOIND_BIN = wrapper;
process.env.ORD_BIN = binaries.ORD_BIN;
const env = await startRegtest().finally(() => {
  if (priorCore === undefined) delete process.env.BITCOIND_BIN; else process.env.BITCOIND_BIN = priorCore;
  if (priorOrd === undefined) delete process.env.ORD_BIN; else process.env.ORD_BIN = priorOrd;
});
const json = async <T>(path: string): Promise<T> => {
  const response = await fetch(env.ordUrl + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, path);
  try { return await response.json() as T; }
  catch (cause) { throw new Error(`Invalid JSON from ord ${path}`, { cause }); }
};
const ordWallet = async <T>(...args: string[]): Promise<T> => {
  const child = Bun.spawn([binaries.ORD_BIN, '--regtest', '--bitcoin-rpc-url', env.rpcUrl,
    '--cookie-file', join(env.dataDir, 'core', 'regtest', '.cookie'), '--data-dir', join(env.dataDir, 'ord-wallet'),
    'wallet', '--server-url', env.ordUrl, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const output = new Response(child.stdout).text();
  const error = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const code = await child.exited;
    assert.equal(code, 0, `ord wallet ${args[0]}: ${await error}`);
    try { return JSON.parse(await output) as T; }
    catch (cause) { throw new Error(`Invalid JSON from ord wallet ${args[0]}`, { cause }); }
  } finally { clearTimeout(timeout); }
};
const endpointsStopped = async () => {
  for (const endpoint of [env.rpcUrl, env.ordUrl]) {
    await assertEndpointStopped(endpoint);
  }
};
try {
  assert.equal((await env.rpc<{ chain: string }>('getblockchaininfo')).chain, 'regtest');
  assert.ok(await env.rpc<number>('getbalance', [], 'originals-regtest') > 0, 'mature spendable coinbase funds');
  // ord creates a fresh throwaway descriptor wallet. Do not print its mnemonic.
  await ordWallet('create');
  const { addresses } = await ordWallet<{ addresses: string[] }>('receive');
  assert.ok(addresses[0]?.startsWith('bcrt1'));
  await env.fund(addresses[0], 1);
  const content = 'Originals Core/ord restart proof\n';
  const file = join(env.dataDir, 'restart-proof.txt');
  await writeFile(file, content);
  const inscription = await ordWallet<{ commit: string; reveal: string; inscriptions: Array<{ id: string }> }>(
    'inscribe', '--fee-rate', '2', '--file', file);
  const inscriptionId = inscription.inscriptions[0].id;
  await env.mine();
  const baselineInscription = await json<{ id: string; sat: number; satpoint: string }>('/inscription/' + inscriptionId);
  const snapshot = async () => ({
    tip: await env.rpc<string>('getbestblockhash'),
    height: await env.rpc<number>('getblockcount'),
    walletBalance: await env.rpc<number>('getbalance', [], 'originals-regtest'),
    ordWalletBalance: await env.rpc<number>('getbalance', [], 'ord'),
    wallets: (await env.rpc<string[]>('listwallets')).sort(),
  });
  const verifyContent = async () => {
    assert.deepEqual(await json('/inscription/' + inscriptionId), baselineInscription);
    const response = await fetch(`${env.ordUrl}/content/${inscriptionId}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content, 'indexed inscription bytes survive process restarts');
  };
  const restarts = [];
  for (const target of ['ord', 'core', 'both'] as RegtestRestartTarget[]) {
    console.log(JSON.stringify({ stage: 'restart', target, dataDir: env.dataDir }));
    const before = await snapshot();
    const authBefore = env.rpcAuth;
    await env.restart(target);
    assert.deepEqual(await snapshot(), before, `${target} restart preserves chain and loaded wallets`);
    assert.equal(env.rpcAuth !== authBefore, target !== 'ord', 'Core restart refreshes cookie auth');
    await verifyContent();
    const [nextBlock] = await env.mine();
    const indexedBlock = await fetch(`${env.ordUrl}/blockhash/${before.height + 1}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(indexedBlock.status, 200);
    assert.equal((await indexedBlock.text()).replaceAll('"', '').trim(), nextBlock);
    restarts.push({ target, preservedTip: before.tip, preservedHeight: before.height, indexedNextBlock: nextBlock,
      cookieRotated: env.rpcAuth !== authBefore });
  }
  // Concurrent requests queue instead of racing over the same datadir/ports.
  const beforeConcurrent = await snapshot();
  await Promise.all([env.restart('ord'), env.restart('both')]);
  assert.deepEqual(await snapshot(), beforeConcurrent);
  await verifyContent();
  // A failed restart must reject, preserve logs and stop the surviving service.
  await writeFile(failureFlag, 'fail only this isolated environment');
  await assert.rejects(env.restart('core'), /Regtest core restart failed/);
  await endpointsStopped();
  await env.stop();
  await env.stop();
  await assert.rejects(env.restart(), /stopped regtest environment/);
  const logs = (await readdir(env.dataDir)).filter(name => /\.log$/.test(name)).sort();
  assert.ok(logs.includes('bitcoin.log') && logs.includes('bitcoin.1.log') && logs.includes('ord.1.log'));
  const receipt = { result: 'pass', chain: 'regtest', ...env.versions, inscriptionId,
    inscriptionSat: baselineInscription.sat, contentSha256: createHash('sha256').update(content).digest('hex'),
    restarts, dataDir: env.dataDir, logs, checks: ['mature funded wallet', 'real mined inscription',
      'ord-only restart', 'Core-only restart', 'combined restart', 'same chain and wallet balances',
      'cookie refresh', 'inscription satpoint and bytes preserved', 'new block indexed after each restart',
      'serialized concurrent restarts', 'failed restart rejects and stops both endpoints',
      'repeat stop is safe', 'restart after stop rejects', 'all process-generation logs retained'] };
  await writeFile(join(env.dataDir, 'restart-receipt.json'), JSON.stringify(receipt, null, 2));
  if (process.env.REGTEST_RECEIPT) await writeFile(process.env.REGTEST_RECEIPT, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { await env.stop(); }
