import { mkdtemp, mkdir, readFile, copyFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

export type RegtestRestartTarget = 'core' | 'ord' | 'both';

/** Disposable real nodes, with no public peers, public RPC or production wallet. */
export async function startRegtest(options: { indexAddresses?: boolean } = {}) {
  const indexAddresses = options.indexAddresses ?? true;
  const dataDir = await mkdtemp(join(tmpdir(), 'originals-regtest-'));
  const coreDir = join(dataDir, 'core');
  await mkdir(coreDir);
  // ord 0.29.0 caches its RPC credentials for the process lifetime. Give only
  // the indexer a stable, disposable rpcauth identity so a Core-only restart
  // can rotate the default cookie without stranding the running indexer.
  const ordPassword = randomBytes(32).toString('hex');
  const ordSalt = randomBytes(16).toString('hex');
  const ordAuth = `originals-regtest-ord:${ordSalt}$${createHmac('sha256', ordSalt).update(ordPassword).digest('hex')}`;
  const ordCookie = join(dataDir, 'ord-rpc.cookie');
  await writeFile(ordCookie, `originals-regtest-ord:${ordPassword}`, { mode: 0o600 });
  // Reserve both together so the OS cannot hand us the same port twice.
  const reservations = [0, 1].map(() => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }));
  const [rpcUrl, ordUrl] = reservations.map(server => server.url.origin);
  reservations.forEach(server => server.stop(true));
  const bitcoin = process.env.BITCOIND_BIN ?? 'bitcoind';
  const ord = process.env.ORD_BIN ?? 'ord';
  const version = async (binary: string, flag: string) => {
    const command = Bun.spawn([binary, flag], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(command.stdout).text();
    if (await command.exited) throw new Error(`Cannot read version: ${binary}`);
    return output.split('\n')[0].trim();
  };
  const [coreVersion, ordVersion] = await Promise.all([version(bitcoin, '-version'), version(ord, '--version')]);
  const children: Subprocess[] = [];
  const generations = { bitcoin: 0, ord: 0 };
  let coreChild: Subprocess;
  let ordChild: Subprocess;
  let closing = false;
  let lifecycle = Promise.resolve();
  const serialize = (action: () => Promise<void>) => {
    const result = lifecycle.then(action);
    lifecycle = result.catch(() => {});
    return result;
  };
  const spawn = (command: string[], name: 'bitcoin' | 'ord') => {
    // Keep each generation's logs, including failed restart attempts.
    const generation = generations[name]++;
    const logName = generation ? `${name}.${generation}` : name;
    // Bun can inherit RLIM_INFINITY on macOS; Core's fd-limit conversion then
    // reports -1 available. Bound only this child process, not the user's shell.
    const child = Bun.spawn(['/bin/sh', '-c', 'ulimit -n 4096\nexec "$@"', 'regtest-node', ...command], {
      stdout: Bun.file(join(dataDir, `${logName}.log`)),
      stderr: Bun.file(join(dataDir, `${logName}.error.log`)),
    });
    children.push(child);
    return child;
  };
  const terminate = async (child: Subprocess) => {
    if (child.exitCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([child.exited, Bun.sleep(5_000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
  };
  const stopChildren = async () => {
    // Attempt every shutdown even if one process cannot be signalled.
    const errors: unknown[] = [];
    for (const child of [...children].reverse()) {
      try { await terminate(child); } catch (error) { errors.push(error); }
    }
    if (process.env.REGTEST_LOGS_DIR) {
      try {
        await mkdir(process.env.REGTEST_LOGS_DIR, { recursive: true });
        for (const name of await readdir(dataDir)) {
          if (/^(bitcoin|ord)(\.\d+)?(\.error)?\.log$/.test(name)) {
            await copyFile(join(dataDir, name), join(process.env.REGTEST_LOGS_DIR, name));
          }
        }
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Regtest shutdown failed; logs: ${dataDir}`);
  };
  const stop = () => {
    closing = true;
    return serialize(stopChildren);
  };
  let rpcAuth = '';
  async function rpc<T = unknown>(method: string, params: unknown[] = [], wallet?: string, timeoutMs = 10_000): Promise<T> {
    const response = await fetch(rpcUrl + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : ''), {
      method: 'POST', headers: { authorization: `Basic ${btoa(rpcAuth)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'originals-regtest', method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json() as { result: T; error?: { message: string } };
    if (!response.ok || body.error) throw new Error(`${method}: ${body.error?.message ?? response.status}`);
    return body.result;
  }
  const assertRunning = (child: Subprocess, name: string) => {
    if (child.exitCode !== null) throw new Error(`${name} exited (${child.exitCode}); logs: ${dataDir}`);
  };
  const startCore = async () => {
    coreChild = spawn([bitcoin, `-datadir=${coreDir}`, '-regtest=1', '-server=1', '-txindex=1', '-listen=0', '-fallbackfee=0.00002',
      '-dnsseed=0', `-rpcauth=${ordAuth}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${new URL(rpcUrl).port}`], 'bitcoin');
    await until('Bitcoin RPC', async () => {
      rpcAuth = (await readFile(join(coreDir, 'regtest', '.cookie'), 'utf8')).trim();
      const info = await rpc<{ chain: string }>('getblockchaininfo');
      if (info.chain !== 'regtest') throw new Error('Expected regtest');
      return true;
    }, 30_000, () => assertRunning(coreChild, 'Bitcoin Core'));
  };
  const startOrd = () => {
    ordChild = spawn([ord, '--regtest', '--bitcoin-rpc-url', rpcUrl, '--cookie-file', ordCookie,
      '--data-dir', join(dataDir, 'ord'), '--index-sats', ...(indexAddresses ? ['--index-addresses'] : []), '--index-transactions',
      '--index-cache-size', '33554432', '--commit-interval', '1', '--savepoint-interval', '1', '--max-savepoints', '20',
      'server', '--address', '127.0.0.1', '--http-port', new URL(ordUrl).port, '--polling-interval', '100ms'], 'ord');
  };
  async function sync() {
    const tip = await rpc<{ blocks: number; bestblockhash: string }>('getblockchaininfo');
    await until('ord indexed tip', async () => {
      const response = await fetch(`${ordUrl}/status`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`ord status: ${response.status}`);
      const status = await response.json() as { chain: string; height: number; sat_index: boolean; address_index: boolean; unrecoverably_reorged: boolean };
      if (status.chain !== 'regtest' || !status.sat_index || status.address_index !== indexAddresses || status.unrecoverably_reorged) throw new Error('ord does not have the required regtest indexes');
      if (status.height !== tip.blocks) return false;
      const indexed = await fetch(`${ordUrl}/blockhash/${tip.blocks}`, { signal: AbortSignal.timeout(2_000) });
      if (!indexed.ok) throw new Error(`ord blockhash: ${indexed.status}`);
      return (await indexed.text()).replaceAll('"', '').trim() === tip.bestblockhash;
    }, 30_000, () => { assertRunning(coreChild, 'Bitcoin Core'); assertRunning(ordChild, 'ord'); });
  }
  const restart = (target: RegtestRestartTarget = 'both') => serialize(async () => {
    if (closing) throw new Error('Cannot restart a stopped regtest environment');
    if (!['core', 'ord', 'both'].includes(target)) throw new Error(`Unknown regtest restart target: ${target}`);
    try {
      const restartCore = target !== 'ord';
      const restartOrd = target !== 'core';
      const wallets = restartCore ? await rpc<string[]>('listwallets') : [];
      if (restartOrd) await terminate(ordChild);
      if (restartCore) {
        await terminate(coreChild);
        await startCore();
        const loaded = await rpc<string[]>('listwallets');
        for (const wallet of wallets) if (!loaded.includes(wallet)) await rpc('loadwallet', [wallet]);
      }
      if (restartOrd) startOrd();
      await sync();
    } catch (error) {
      closing = true;
      try { await stopChildren(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], `Regtest ${target} restart and cleanup failed; logs: ${dataDir}`); }
      throw new Error(`Regtest ${target} restart failed; logs: ${dataDir}`, { cause: error });
    }
  });
  try {
    await startCore();
    await rpc('createwallet', ['originals-regtest']);
    const miningAddress = await rpc<string>('getnewaddress', ['', 'bech32'], 'originals-regtest');
    // Bootstrap mines a mature wallet in one mutation; allow slow CI disks without retrying it.
    await rpc('generatetoaddress', [101, miningAddress], undefined, 60_000);
    startOrd();
    await sync();
    return {
      dataDir, rpcUrl, ordUrl, get rpcAuth() { return rpcAuth; }, rpc, sync, stop, restart,
      versions: { core: coreVersion, ord: ordVersion },
      async mine(blocks = 1) { const hashes = await rpc<string[]>('generatetoaddress', [blocks, miningAddress]); await sync(); return hashes; },
      async fund(address: string, amount = 0.01) {
        const txid = await rpc<string>('sendtoaddress', [address, amount], 'originals-regtest');
        await rpc('generatetoaddress', [1, miningAddress]); await sync(); return txid;
      },
    };
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Regtest startup and cleanup failed; logs: ${dataDir}`); }
    throw new Error(`Regtest startup failed; logs: ${dataDir}`, { cause: error });
  }
}

export async function until(label: string, check: () => Promise<boolean>, timeoutMs = 30_000, assertReadyToRetry?: () => void) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    assertReadyToRetry?.();
    try { if (await check()) return; } catch (error) { last = error; }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: last });
}

if (import.meta.main) {
  const env = await startRegtest();
  console.log(JSON.stringify({ dataDir: env.dataDir, rpcUrl: env.rpcUrl, ordUrl: env.ordUrl }));
  await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  await env.stop();
}
