/**
 * #975 stage A: the landing's anchoring path with a real, client-authorized
 * Turnkey signer, on disposable regtest. Owner-run, interactive; see
 * docs/regtest/originals-live-acceptance.md. Nothing here touches mainnet,
 * testnet or signet, and nothing is spent but regtest coins.
 *
 * It starts Core 31.1 and ord 0.29.0, builds the SPA with
 * VITE_BTC_NETWORK=regtest, VITE_ORIGINALS_BITCOIN_ANCHORING=1 and a short
 * Turnkey session (VITE_TURNKEY_SESSION_SECONDS, default 300), and runs
 * apps/landing/serve.ts with the Turnkey credentials of a NON-PRODUCTION
 * organization from the environment. The owner signs in by email OTP in a
 * real browser; the session key stays in that browser's IndexedDB, and every
 * signature (the author's entry, the deposit key's commit) is authorized
 * there. This process never sees a key.
 *
 * Refuses to start unless LIVE_TURNKEY_NON_PRODUCTION_ORG=1 (the owner's
 * statement that TURNKEY_ORGANIZATION_ID is not the production organization)
 * and the three TURNKEY_* values are set. Credentials are never printed or
 * written to the receipt; the organization id is recorded as a SHA-256.
 *
 * Commands (stdin):
 *   fund <bcrt1 address> [btc]   send regtest coins (default 0.002) and mine one block
 *   mine [n]                     mine n blocks (default 1)
 *   hold-reveal                  the next reveal broadcast through the server is held (not answered)
 *   kill                         SIGKILL the server (use after hold-reveal reports a held reveal)
 *   restart                      start a fresh server process on the same data directory
 *   verify <did> <zip>           a fresh reader: empty store, no author list, the evidence
 *                                package downloaded from the page, and the sat read from ord/Core
 *   note <text>                  add the owner's observation to the receipt (what was clicked, seen)
 *   receipt [path]               write the receipt (default ./originals-live-receipt-<time>.json)
 *   quit                         stop everything
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyOriginal } from '@originals/vh/originals';
import { RegtestProvider } from '@originals/sdk';
import { OriginalsSDK, readEvidence, satEvidence } from '../../packages/sdk/src/originals/index';
import { FileStore } from '../../packages/sdk/src/originals/fs-store';
import { regtestIndexer } from '../../apps/landing/server/regtest';
import { ORD_INDEX, headerClock, rpcClient } from './originals-writer-child';
import { startRegtest } from './environment';

const root = fileURLToPath(new URL('../../', import.meta.url));
const BCRT = { ...btc.TEST_NETWORK, bech32: 'bcrt' };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/regtest/originals-live-acceptance.md)`);
  return value;
}

if (process.env.LIVE_TURNKEY_NON_PRODUCTION_ORG !== '1') {
  throw new Error('Set LIVE_TURNKEY_NON_PRODUCTION_ORG=1 to state that TURNKEY_ORGANIZATION_ID is a non-production organization. Production Turnkey credentials need the owner\'s separate approval.');
}
const turnkey = { TURNKEY_API_PUBLIC_KEY: required('TURNKEY_API_PUBLIC_KEY'), TURNKEY_API_PRIVATE_KEY: required('TURNKEY_API_PRIVATE_KEY'), TURNKEY_ORGANIZATION_ID: required('TURNKEY_ORGANIZATION_ID') };
const sessionSeconds = process.env.VITE_TURNKEY_SESSION_SECONDS ?? '300';
const port = Number(process.env.PORT ?? 3000);
const JWT_SECRET = hex.encode(crypto.getRandomValues(new Uint8Array(32)));

const notes: Array<{ at: string; text: string }> = [];
const events: Array<{ at: string; event: string; [k: string]: unknown }> = [];
const log = (event: string, facts: Record<string, unknown> = {}) => {
  events.push({ at: new Date().toISOString(), event, ...facts });
  console.log(`live: ${event}`, Object.keys(facts).length ? JSON.stringify(facts) : '');
};

const env = await startRegtest({ logsDir: process.env.ORIGINALS_REGTEST_LOGS });
const rpc = rpcClient({ rpcUrl: env.rpcUrl, ordUrl: env.ordUrl, rpcAuth: env.rpcAuth });
const provider = new RegtestProvider({ rpcUrl: env.rpcUrl, ordUrl: env.ordUrl, rpcAuth: env.rpcAuth });
const indexer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: regtestIndexer(provider) });

// Core RPC for the server through this process, so a reveal can be held and the server killed between commit and reveal.
let holding = false;
let relayed = new Set<string>();
const proxy = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(req) {
    const body = await req.text();
    let message: { method?: string; params?: unknown[] } | unknown[] = [];
    try { message = JSON.parse(body); } catch { /* forwarded */ }
    if (holding && !Array.isArray(message) && message.method === 'sendrawtransaction') {
      const tx = btc.Transaction.fromRaw(hex.decode(String(message.params?.[0])), { allowUnknownInputs: true, allowUnknownOutputs: true });
      const spends = Array.from({ length: tx.inputsLength }, (_, i) => hex.encode(tx.getInput(i).txid!));
      if (spends.some((t) => relayed.has(t))) {
        log('reveal-held', { reveal: tx.id, next: 'kill, then restart' });
        holding = false;
        return new Promise<Response>(() => {});
      }
      relayed.add(tx.id);
    }
    const res = await fetch(env.rpcUrl + new URL(req.url).pathname, { method: req.method, headers: req.headers, body });
    return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
  },
});

const dataDir = await mkdtemp(join(tmpdir(), 'landing-live-'));
const logDir = process.env.ORIGINALS_REGTEST_LOGS ?? dataDir;
await mkdir(logDir, { recursive: true });

const buildEnv = { VITE_BTC_NETWORK: 'regtest', VITE_ORIGINALS_BITCOIN_ANCHORING: '1', VITE_TURNKEY_SESSION_SECONDS: sessionSeconds };
const build = Bun.spawn([process.execPath, 'x', 'vite', 'build'], { cwd: join(root, 'apps/landing'), env: { ...process.env, ...buildEnv }, stdout: 'inherit', stderr: 'inherit' });
if (await build.exited) throw new Error('SPA build failed');
log('spa-built', { ...buildEnv, outDir: 'apps/landing/dist' });

const running: { server: Subprocess | null } = { server: null };
let generation = 0;
const serverLogs: string[] = [];
async function start() {
  const file = join(logDir, `landing-server.${generation++}.log`);
  serverLogs.push(file);
  const server = Bun.spawn([process.execPath, 'apps/landing/serve.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PORT: String(port), JWT_SECRET, ...turnkey,
      BTC_NETWORK: 'regtest', REGTEST_RPC_URL: proxy.url.origin, REGTEST_ORD_URL: env.ordUrl, REGTEST_RPC_AUTH: env.rpcAuth,
      BTC_INDEXER_API: indexer.url.origin, ORIGINALS_DATA_DIR: dataDir, BTC_BLOCKS_WS_URL: 'off',
      ORIGINALS_BITCOIN_ANCHORING: '1', ...buildEnv,
    },
    stdout: Bun.file(file), stderr: Bun.file(`${file}.err`),
  });
  for (let k = 0; k < 300; k++) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(100);
  }
  running.server = server;
  log('server-started', { pid: server.pid, url: `http://localhost:${port}`, generation: generation - 1 });
}
await start();

/** Every recorded pair, with whether its commit's inputs were signed by the key behind the account's bound deposit address. */
async function recordedPairs() {
  const base = join(dataDir, 'originals-anchoring');
  const out: Array<Record<string, unknown>> = [];
  for (const sub of await readdir(base).catch(() => [] as string[])) {
    const bindings = JSON.parse(await readFile(join(dataDir, 'deposits', `${sub}.json`), 'utf8').catch(() => '{}')) as Record<string, { address?: string } | string>;
    const bound = Object.values(bindings).map((b) => (typeof b === 'string' ? b : b?.address)).filter(Boolean) as string[];
    for (const key of await readdir(join(base, sub)).catch(() => [] as string[])) {
      const did = await readFile(join(base, sub, key, 'did'), 'utf8').catch(() => null);
      if (!did) continue;
      const recovery = join(base, sub, key, 'recovery');
      for (const f of (await readdir(recovery).catch(() => [] as string[])).filter((n) => n.endsWith('.json'))) {
        const r = JSON.parse(await readFile(join(recovery, f), 'utf8')) as { recoveryId: string; broadcast: string; prepared: { signedCommitHex: string; revealTxId: string; inscriptionId: string; fundingUtxos: Array<{ txid: string; vout: number }> } };
        const commit = btc.Transaction.fromRaw(hex.decode(r.prepared.signedCommitHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
        const signers = Array.from({ length: commit.inputsLength }, (_, i) => {
          const w = commit.getInput(i).finalScriptWitness;
          return w && w.length === 2 ? btc.p2wpkh(w[1], BCRT).address : null;
        });
        const status = await provider.getTransactionStatus(r.prepared.revealTxId).catch(() => null);
        out.push({
          sub, did, recoveryId: r.recoveryId, inscriptionId: r.prepared.inscriptionId, broadcast: r.broadcast,
          inputZero: `${r.prepared.fundingUtxos[0].txid}:${r.prepared.fundingUtxos[0].vout}`,
          commitSignedBy: signers, boundDepositAddress: bound,
          signedByBoundAddressKey: signers.every((s) => s !== null && bound.includes(s)),
          reveal: status ? { confirmed: status.confirmed, confirmations: status.confirmations ?? 0 } : null,
        });
      }
    }
  }
  return out;
}

async function freshReader(did: string, zipPath: string) {
  const zip = new Uint8Array(await readFile(zipPath));
  const contents = readEvidence(zip);
  const alias = (contents.log.trimEnd().split('\n').map((l) => JSON.parse(l) as { state?: { asset?: { aliases?: string[] } } })
    .flatMap((e) => e.state?.asset?.aliases ?? []).find((a) => a.startsWith('did:btco:')));
  if (!alias) throw new Error('the package names no did:btco sat');
  const sat = alias.slice(alias.lastIndexOf(':') + 1);
  const snapshot = await provider.getSatSnapshot(sat, { bodies: 'originals' });
  const satpoint = snapshot.ownership.satpoint;
  const ownerConfirmations = satpoint ? (await provider.getTransactionStatus(satpoint.split(':')[0])).confirmations ?? 0 : 0;
  const evidence = await satEvidence(snapshot, { clock: headerClock(rpc), ownerConfirmations, index: ORD_INDEX });
  const reader = OriginalsSDK.create({ store: await FileStore.open(await mkdtemp(join(tmpdir(), 'live-reader-'))), authors: [] });
  const { report: r } = await reader.load(zip, { bitcoin: [evidence] });
  const alone = await verifyOriginal({ bitcoin: [evidence], authors: contents.authors.map(({ retrievedFrom: _, ...a }) => a), now: Date.now() });
  const result = {
    did, packageFor: r.original, sat: alias, network: snapshot.network, index: evidence.index, indexesConsulted: 1,
    history: r.history.status, authorBinding: r.authorBinding.status, identity: r.identityEvidence.status, author: r.identityEvidence.author,
    anchoring: r.anchoring?.status, head: r.head, current: r.current, ownership: r.ownership,
    resources: r.resources.versions.map((v) => ({ resource: v.resource, version: v.version, bytes: v.bytes, sha256: contents.bytes[v.digest] ? hex.encode(sha256(contents.bytes[v.digest])) : null })),
    fromBitcoinAlone: { anchoring: alone.anchoring?.status, head: alone.head, history: alone.history.status, authorBinding: alone.authorBinding.status },
  };
  log('fresh-reader', result);
  return result;
}

const readers: unknown[] = [];
async function receipt(path?: string) {
  const out = {
    stage: '#975 stage A (regtest, live client-authorized Turnkey)',
    revision: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(),
    dirty: (await Bun.$`git -C ${root} status --porcelain`.text()).trim().length > 0,
    versions: env.versions,
    turnkey: { organization: `sha256:${hex.encode(sha256(new TextEncoder().encode(turnkey.TURNKEY_ORGANIZATION_ID)))}`, statedNonProduction: true, sessionSeconds: Number(sessionSeconds), apiBase: 'https://api.turnkey.com' },
    signers: { author: 'Turnkey authorship key (#key-1, Ed25519), via the browser session', commit: 'Turnkey deposit key (P2WPKH), via the browser session', reveal: 'SDK ephemeral key' },
    server: { entry: 'apps/landing/serve.ts', processes: generation, index: 'ord@regtest-local', indexesCompared: false },
    pairs: await recordedPairs(),
    moneyLog: (await Promise.all(serverLogs.map((f) => readFile(f, 'utf8').catch(() => '')))).join('\n').split('\n').filter((l) => l.includes('originals_anchor_')),
    readers, notes, events,
    limits: [
      'Turnkey activity ids are not visible to this process: record them from the Turnkey dashboard with `note`.',
      'One ord index; no second index compared (PROVISIONAL, owner decision).',
      'Regtest only: no public mempool, fee market or QuickNode provider behaviour.',
    ],
  };
  const file = path ?? join(process.cwd(), `originals-live-receipt-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(out, null, 2));
  log('receipt-written', { file });
}

console.log(`\nOpen http://localhost:${port}, sign in by email, and follow docs/regtest/originals-live-acceptance.md. Type commands here.\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  try {
    if (cmd === 'fund') {
      const txid = await env.fund(args[0], Number(args[1] ?? 0.002));
      log('funded', { address: args[0], btc: Number(args[1] ?? 0.002), txid });
    } else if (cmd === 'mine') {
      await env.mine(Number(args[0] ?? 1));
      log('mined', { blocks: Number(args[0] ?? 1), tip: (await rpc<{ blocks: number }>('getblockchaininfo')).blocks });
    } else if (cmd === 'hold-reveal') {
      holding = true;
      relayed = new Set();
      log('holding-next-reveal');
    } else if (cmd === 'kill') {
      running.server?.kill('SIGKILL');
      log('server-killed', { exit: await running.server?.exited, mempool: await rpc<string[]>('getrawmempool') });
      running.server = null;
    } else if (cmd === 'restart') {
      if (running.server) throw new Error('kill the running server first');
      await start();
    } else if (cmd === 'verify') {
      readers.push(await freshReader(args[0], args[1]));
    } else if (cmd === 'note') {
      notes.push({ at: new Date().toISOString(), text: args.join(' ') });
    } else if (cmd === 'receipt') {
      await receipt(args[0]);
    } else if (cmd === 'quit') {
      break;
    } else if (cmd) {
      console.log('commands: fund, mine, hold-reveal, kill, restart, verify, note, receipt, quit');
    }
  } catch (error) {
    console.error(`live: ${cmd} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
running.server?.kill('SIGKILL');
indexer.stop(true);
proxy.stop(true);
await env.stop();
