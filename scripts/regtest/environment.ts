import { mkdtemp, mkdir, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

/** Disposable real nodes, with no public peers, public RPC or production wallet. */
export async function startRegtest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'originals-regtest-'));
  const coreDir = join(dataDir, 'core');
  await mkdir(coreDir);
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
  const spawn = (command: string[], name: string) => {
    // Bun can inherit RLIM_INFINITY on macOS; Core's fd-limit conversion then
    // reports -1 available. Bound only this child process, not the user's shell.
    const child = Bun.spawn(['/bin/sh', '-c', 'ulimit -n 4096\nexec "$@"', 'regtest-node', ...command], {
      stdout: Bun.file(join(dataDir, `${name}.log`)),
      stderr: Bun.file(join(dataDir, `${name}.error.log`)),
    });
    children.push(child);
    return child;
  };
  const stop = async () => {
    for (const child of [...children].reverse()) {
      if (child.exitCode !== null) continue;
      child.kill('SIGINT');
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    }
    if (process.env.REGTEST_LOGS_DIR) {
      await mkdir(process.env.REGTEST_LOGS_DIR, { recursive: true });
      for (const name of ['bitcoin.log', 'bitcoin.error.log', 'ord.log', 'ord.error.log']) {
        try { await copyFile(join(dataDir, name), join(process.env.REGTEST_LOGS_DIR, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
  };
  let rpcAuth = '';
  async function rpc<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const response = await fetch(rpcUrl + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : ''), {
      method: 'POST', headers: { authorization: `Basic ${btoa(rpcAuth)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'originals-regtest', method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as { result: T; error?: { message: string } };
    if (!response.ok || body.error) throw new Error(`${method}: ${body.error?.message ?? response.status}`);
    return body.result;
  }
  try {
    spawn([bitcoin, `-datadir=${coreDir}`, '-regtest=1', '-server=1', '-txindex=1', '-listen=0', '-fallbackfee=0.00002',
      '-dnsseed=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${new URL(rpcUrl).port}`], 'bitcoin');
    await until('Bitcoin RPC', async () => {
      rpcAuth = (await readFile(join(coreDir, 'regtest', '.cookie'), 'utf8')).trim();
      const info = await rpc<{ chain: string }>('getblockchaininfo');
      if (info.chain !== 'regtest') throw new Error('Expected regtest');
      return true;
    });
    await rpc('createwallet', ['originals-regtest']);
    const miningAddress = await rpc<string>('getnewaddress', ['', 'bech32'], 'originals-regtest');
    await rpc('generatetoaddress', [101, miningAddress]);
    spawn([ord, '--regtest', '--bitcoin-rpc-url', rpcUrl, '--cookie-file', join(coreDir, 'regtest', '.cookie'),
      '--data-dir', join(dataDir, 'ord'), '--index-sats', '--index-addresses', '--index-transactions',
      '--index-cache-size', '33554432', '--commit-interval', '1', '--savepoint-interval', '1', '--max-savepoints', '20',
      'server', '--address', '127.0.0.1', '--http-port', new URL(ordUrl).port, '--polling-interval', '100ms'], 'ord');
    async function sync() {
      const tip = await rpc<{ blocks: number; bestblockhash: string }>('getblockchaininfo');
      await until('ord indexed tip', async () => {
        const status = await (await fetch(`${ordUrl}/status`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2_000) })).json() as { chain: string; height: number; sat_index: boolean; address_index: boolean; unrecoverably_reorged: boolean };
        if (status.chain !== 'regtest' || !status.sat_index || !status.address_index || status.unrecoverably_reorged) throw new Error('ord does not have the required regtest indexes');
        if (status.height !== tip.blocks) return false;
        const indexedHash = await (await fetch(`${ordUrl}/blockhash/${tip.blocks}`, { signal: AbortSignal.timeout(2_000) })).text();
        return indexedHash.replaceAll('"', '').trim() === tip.bestblockhash;
      });
    }
    await sync();
    return {
      dataDir, rpcUrl, ordUrl, rpcAuth, rpc, sync, stop,
      versions: { core: coreVersion, ord: ordVersion },
      async mine(blocks = 1) { const hashes = await rpc<string[]>('generatetoaddress', [blocks, miningAddress]); await sync(); return hashes; },
      async fund(address: string, amount = 0.01) {
        const txid = await rpc<string>('sendtoaddress', [address, amount], 'originals-regtest');
        await rpc('generatetoaddress', [1, miningAddress]); await sync(); return txid;
      },
    };
  } catch (error) {
    await stop();
    throw new Error(`Regtest startup failed; logs: ${dataDir}`, { cause: error });
  }
}

export async function until(label: string, check: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
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
