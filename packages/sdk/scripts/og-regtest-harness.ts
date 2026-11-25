// A disposable regtest chain for the did:og scripts: Bitcoin Core and ord 0.29.x in a new
// temporary directory, on free local ports, removed when done. Regtest only.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CoreRpcBackend, OrdExplorer } from '../src/og/chain.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => res(port)); });
});

/**
 * A binary on PATH outside node_modules: `bun run` puts node_modules/.bin first, and
 * micro-ordinals ships its own `ord` CLI there, which is not the ord index.
 */
export function binary(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir || dir.includes('node_modules')) continue;
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return name;
}

export interface Regtest {
  tmp: string;
  core: CoreRpcBackend;
  ord: OrdExplorer;
  wallet: <T>(method: string, params?: unknown[]) => Promise<T>;
  mine: (n: number) => Promise<unknown>;
  ordSync: () => Promise<number>;
  versions: { bitcoind: string; ord: string };
  cleanup: () => void;
}

export async function startRegtest(opts: { keep?: boolean; label?: string } = {}): Promise<Regtest> {
  const BITCOIND = process.env.BITCOIND ?? binary('bitcoind');
  const ORD = process.env.ORD ?? binary('ord');
  const tmp = mkdtempSync(join(tmpdir(), `${opts.label ?? 'og-regtest'}-`));
  const procs: ChildProcess[] = [];
  const cleanup = () => {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
    if (opts.keep) return;
    const t = Date.now();
    while (procs.some((p) => p.exitCode === null && p.signalCode === null) && Date.now() - t < 5000) execFileSync('sleep', ['0.1']);
    rmSync(tmp, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  const [rpcPort, p2pPort, ordPort] = [await freePort(), await freePort(), await freePort()];
  const user = 'og', pass = randomBytes(12).toString('hex');
  const btcDir = join(tmp, 'bitcoin'), ordDir = join(tmp, 'ord');
  mkdirSync(btcDir); mkdirSync(ordDir);
  const ordVersion = execFileSync(ORD, ['--version']).toString().trim();
  if (!/^ord 0\.29\.\d+$/.test(ordVersion)) throw new Error(`ord 0.29.x required (P9.31), found ${ordVersion}`);
  const bitcoindVersion = execFileSync(BITCOIND, ['--version']).toString().split('\n')[0].trim();
  procs.push(spawn(BITCOIND, ['-regtest', `-datadir=${btcDir}`, `-rpcport=${rpcPort}`, `-port=${p2pPort}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1',
    `-rpcuser=${user}`, `-rpcpassword=${pass}`, '-listen=0', '-dnsseed=0', '-fixedseeds=0', '-txindex=1', '-server=1', '-fallbackfee=0.0002', '-printtoconsole=0'], { stdio: 'ignore' }));
  const core = new CoreRpcBackend(`http://127.0.0.1:${rpcPort}`, `${user}:${pass}`, 2);
  for (let i = 0; ; i++) { try { await core.rpc('getblockchaininfo'); break; } catch (e) { if (i > 300) throw e; await sleep(100); } }
  if ((await core.rpc<{ chain: string }>('getblockchaininfo')).chain !== 'regtest') throw new Error('not regtest');
  await core.rpc('createwallet', ['og']);
  const walletRpc = new CoreRpcBackend(`http://127.0.0.1:${rpcPort}/wallet/og`, `${user}:${pass}`);
  const wallet = <T>(m: string, p: unknown[] = []) => walletRpc.rpc<T>(m, p);
  const miner = await wallet<string>('getnewaddress', ['', 'bech32m']);
  const mine = (n: number) => core.rpc('generatetoaddress', [n, miner]);
  await mine(120); // coinbase maturity, and past ord's regtest jubilee (110)
  const ordProc = spawn(ORD, ['--regtest', `--bitcoin-rpc-url=http://127.0.0.1:${rpcPort}`, `--bitcoin-rpc-username=${user}`, `--bitcoin-rpc-password=${pass}`,
    `--data-dir=${ordDir}`, '--index-sats', '--index-transactions', 'server', '--address=127.0.0.1', `--http-port=${ordPort}`, '--polling-interval=100ms'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ordErr = ''; ordProc.stderr!.on('data', (d) => { ordErr += d; });
  procs.push(ordProc);
  const ord = new OrdExplorer(`http://127.0.0.1:${ordPort}`);
  const ordSync = async () => {
    const h = await core.rpc<number>('getblockcount');
    for (let i = 0; ; i++) {
      try { if ((await ord.height()) >= h) return h; } catch (e) { if (i > 600) throw new Error(`${(e as Error).message}\n${ordErr}`); }
      await sleep(100);
    }
  };
  await ordSync();
  return { tmp, core, ord, wallet, mine, ordSync, versions: { bitcoind: bitcoindVersion, ord: ordVersion }, cleanup };
}
