/**
 * The landing's anchoring path end to end (plan 011, PR 10b; #975), on
 * Bitcoin Core 31.1 and ord 0.29.0, regtest only. Nothing here touches
 * mainnet, testnet or signet, and nothing calls Turnkey.
 *
 * The server is the landing's own `apps/landing/serve.ts`, run as a child
 * process with ORIGINALS_BITCOIN_ANCHORING=1 against the local nodes, its
 * durable stores in a temporary data directory. The browser is the landing's
 * own `DemoEngine` (`apps/landing/src/sdk/engine.ts`) in this process, signed
 * in by a session cookie the journey mints with the server's JWT secret, and
 * talking to the server only over HTTP: deposit read, sat and fee reads,
 * header and transaction reads, submit and status.
 *
 * What stands in for live pieces, and is labelled so in the receipt:
 * - the author is a local did:vh (not the account's Turnkey did:webvh);
 * - the commit is signed by a disposable local P2WPKH key (not Turnkey);
 * - Core RPC reaches the server through a proxy this journey controls, which
 *   can hold the reveal's broadcast, so the server is killed between commit
 *   and reveal by the network, not by a hook in the server.
 *
 *  1. The deposit route binds the wallet's address and offers its confirmed,
 *     inscription-free outputs. The engine signs the anchoring entry naming
 *     the first sat of the first one (P9.10), prepares and signs the pair
 *     (P9.18), and the server's checked submit sends it. Pending Bitcoin
 *     acceptance while in the mempool; anchored at one confirmation, held at
 *     the account's own address (P9.11).
 *  2. A revision is inscribed on the same sat: input 0 is the output holding
 *     it, an inscribed input the server now accepts because every inscription
 *     on it is on the Original's sat; the fee inputs come from the deposit,
 *     which still offers no inscribed output (plan 011, PR 10b).
 *  3. A second revision: the proxy holds the reveal, the server process is
 *     SIGKILLed with the commit out and the reveal not. A fresh reader of the
 *     sat still sees the first revision as the head (P9.4). A fresh server
 *     process resumes the identical reveal on boot (P9.6); the browser's
 *     retry resends the identical pair from its outbox and is answered from
 *     the record. Mined, the head advances.
 *  4. The block with that reveal is invalidated: the head goes back, and the
 *     next block puts it back (reorg, P9.13).
 *  5. A fresh reader with a new empty store, no author list, the evidence
 *     package and the sat read from ord and Core verifies history, author
 *     binding, the accepted head, the exact resource bytes, the network, the
 *     confirmation depth and the trust boundary (one index; ownership
 *     provisional).
 *
 * Writes a JSON receipt to stdout and to $ORIGINALS_REGTEST_LANDING_EVIDENCE.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { verifyOriginal, parseBtcoAlias } from '@originals/vh/originals';
import { RegtestProvider } from '@originals/sdk';
import { OriginalsSDK, readEvidence, satEvidence } from '../../packages/sdk/src/originals/index';
import { FileStore } from '../../packages/sdk/src/originals/fs-store';
import { regtestIndexer } from '../../apps/landing/server/regtest';
import { serializeCookie } from '../../apps/landing/server/cookies';
import { DemoEngine } from '../../apps/landing/src/sdk/engine';
import { httpAnchoringTransport, memoryOutbox } from '../../apps/landing/src/sdk/anchoring';
import { HttpOrdinalsProvider } from '../../apps/landing/src/sdk/http-ordinals-provider';
import { createLocalAuthor } from '../../apps/landing/src/sdk/local-author';
import { selectFundingUtxos } from '../../apps/landing/src/components/demo-logic';
import { generateArtwork } from '../../apps/landing/src/sdk/artwork';
import { ORD_INDEX, headerClock, localWallet, rpcClient } from './originals-writer-child';
import { startRegtest } from './environment';

const root = fileURLToPath(new URL('../../', import.meta.url));
const JWT_SECRET = hex.encode(crypto.getRandomValues(new Uint8Array(32)));
const SUB = 'regtest-landing-sub-org';
const SERVER_INDEX = 'ord@regtest-local';

type Step = { step: string; [k: string]: unknown };
const steps: Step[] = [];
const record = (step: string, facts: Record<string, unknown> = {}) => {
  steps.push({ step, ...facts });
  console.log(`landing-anchor: ${step}`, JSON.stringify(facts));
};

async function until<T>(what: string, probe: () => Promise<T | undefined | null | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

/**
 * Core RPC for the server, through this journey. With `holdReveal` set, a
 * sendrawtransaction spending a transaction relayed since is never answered
 * (the reveal after its commit): the server then waits on it until killed.
 */
function rpcProxy(target: string) {
  let holdReveal = false;
  let relayed = new Set<string>();
  let onHeld: ((txid: string) => void) | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const body = await req.text();
      let message: { method?: string; params?: unknown[] } | unknown[] = [];
      try { message = JSON.parse(body); } catch { /* forwarded as is */ }
      if (holdReveal && !Array.isArray(message) && message.method === 'sendrawtransaction') {
        const tx = btc.Transaction.fromRaw(hex.decode(String(message.params?.[0])), { allowUnknownInputs: true, allowUnknownOutputs: true });
        const spends = Array.from({ length: tx.inputsLength }, (_, i) => hex.encode(tx.getInput(i).txid!));
        if (spends.some((t) => relayed.has(t))) {
          onHeld?.(tx.id);
          return new Promise<Response>(() => {});
        }
        relayed.add(tx.id);
      }
      const url = new URL(req.url);
      const res = await fetch(target + url.pathname, { method: req.method, headers: req.headers, body });
      return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
    },
  });
  return {
    url: server.url.origin,
    hold(): Promise<string> {
      holdReveal = true;
      relayed = new Set();
      return new Promise((resolve) => { onHeld = resolve; });
    },
    release() { holdReveal = false; onHeld = null; },
    stop() { server.stop(true); },
  };
}

async function main() {
  const logsDir = process.env.ORIGINALS_REGTEST_LOGS;
  const env = await startRegtest(logsDir ? { logsDir } : {});
  const children: Subprocess[] = [];
  const servers: Array<{ stop(force?: boolean): void }> = [];
  try {
    const provider = new RegtestProvider({ rpcUrl: env.rpcUrl, ordUrl: env.ordUrl, rpcAuth: env.rpcAuth });
    const rpc = rpcClient({ rpcUrl: env.rpcUrl, ordUrl: env.ordUrl, rpcAuth: env.rpcAuth });
    const indexer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: regtestIndexer(provider) });
    servers.push(indexer);
    const proxy = rpcProxy(env.rpcUrl);
    servers.push(proxy);

    const dataDir = await mkdtemp(join(tmpdir(), 'landing-anchor-'));
    const logDir = logsDir ?? dataDir;
    await mkdir(logDir, { recursive: true });
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = Number(reservation.url.port);
    reservation.stop(true);
    const base = `http://127.0.0.1:${port}`;
    let generation = 0;
    const serverLogs: string[] = [];

    async function startLanding(): Promise<Subprocess> {
      const log = join(logDir, `landing-server.${generation++}.log`);
      serverLogs.push(log);
      const child = Bun.spawn([process.execPath, 'apps/landing/serve.ts'], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
          PORT: String(port), JWT_SECRET,
          // The auth routes mount only with these. Nothing on this journey calls Turnkey.
          TURNKEY_API_PUBLIC_KEY: '02' + 'a'.repeat(64), TURNKEY_API_PRIVATE_KEY: 'b'.repeat(64), TURNKEY_ORGANIZATION_ID: 'regtest-placeholder',
          BTC_NETWORK: 'regtest', VITE_BTC_NETWORK: 'regtest',
          REGTEST_RPC_URL: proxy.url, REGTEST_ORD_URL: env.ordUrl, REGTEST_RPC_AUTH: env.rpcAuth, BTC_INDEXER_API: indexer.url.origin,
          ORIGINALS_DATA_DIR: dataDir, BTC_BLOCKS_WS_URL: 'off',
          ORIGINALS_BITCOIN_ANCHORING: '1', VITE_ORIGINALS_BITCOIN_ANCHORING: '1',
        },
        stdout: Bun.file(log), stderr: Bun.file(`${log}.err`),
      });
      children.push(child);
      await until('the landing server', async () => (await fetch(`${base}/api/health`)).ok);
      return child;
    }

    let landing = await startLanding();
    const cookie = serializeCookie(getAuthCookieConfig(signToken(SUB, 'regtest@originals.invalid', undefined, { secret: JWT_SECRET })));
    const browserFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, base);
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      return fetch(url, { ...init, headers });
    }) as typeof fetch;
    const getJson = async <T>(path: string): Promise<T> => {
      const res = await browserFetch(path);
      assert.equal(res.status, 200, `${path}: ${res.status} ${await res.clone().text()}`);
      return res.json() as Promise<T>;
    };

    // The disposable holder: one key, funded twice; its address is the account's deposit address.
    const walletKey = secp256k1.utils.randomSecretKey();
    const wallet = localWallet(hex.encode(walletKey));
    await env.fund(wallet.address, 0.0001);
    await env.fund(wallet.address, 0.002);
    type Deposit = { confirmedUtxos: Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>; estimatedCostSats: number; ordinalCheck: string };
    const deposit = async () => {
      const d = await getJson<Deposit>(`/api/btc/deposit?address=${wallet.address}&contentBytes=4000`);
      assert.equal(d.ordinalCheck, 'ok');
      const selection = selectFundingUtxos(d.confirmedUtxos, d.estimatedCostSats);
      assert.ok(selection.selected.length > 0, 'the deposit covers the inscription');
      return { fundingUtxos: selection.selected, changeAddress: wallet.address };
    };

    const outbox = memoryOutbox();
    const transport = httpAnchoringTransport({ baseUrl: base, fetchImpl: browserFetch, provider: new HttpOrdinalsProvider({ baseUrl: base, fetchImpl: browserFetch }) });
    const engine = new DemoEngine({
      networkFlag: 'regtest',
      features: { bitcoinAnchoring: true },
      author: await createLocalAuthor(),
      anchoring: {
        transport,
        outbox, satSigner: wallet.satSigner, network: 'regtest', index: 'ord@landing-regtest',
      },
    });
    const mempool = () => rpc<string[]>('getrawmempool');

    // 1. Anchor.
    const art = generateArtwork('Harbor at dawn', 'Orbits', 7);
    await engine.create('Harbor at dawn', 'Orbits', art.svg);
    const firstFunding = await deposit();
    const anchoredState = await engine.inscribe({ funding: firstFunding });
    const anchorSent = anchoredState.anchoring!.lastSent!;
    assert.equal(anchoredState.layer, 'did:btco');
    assert.equal(anchoredState.anchoring!.status!.publication, 'pending-bitcoin-acceptance');
    assert.equal(anchoredState.anchoring!.status!.current, false);
    assert.ok((await mempool()).includes(anchorSent.revealTxId));
    assert.equal(anchoredState.anchoring!.offChain!.replication, 'not-guaranteed');
    await env.mine(1);
    let state = await engine.anchoringStatus();
    let status = state.anchoring!.status!;
    assert.equal(status.publication, 'anchored');
    assert.equal(status.heads.accepted, anchorSent.versionId);
    assert.equal(status.ownership!.output, `${anchorSent.revealTxId}:0`);
    assert.equal(status.heldByThisAccount, true);
    assert.equal(status.indexes.compared, false);
    const sat = parseBtcoAlias(state.btcoDid!);
    record('anchored', { did: state.did, sat: state.btcoDid, entry: anchorSent.versionId, commit: anchorSent.commitTxId, reveal: anchorSent.revealTxId, holder: status.ownership!.output, confirmations: status.ownership!.confirmations, offChain: anchoredState.anchoring!.offChain });

    // 2. Reinscribe a revision on the same sat.
    state = await engine.update('Harbor at noon', 'Orbits', generateArtwork('Harbor at noon', 'Orbits', 8).svg);
    const firstEdit = state.history.at(-1)!.versionId;
    assert.deepEqual(state.anchoring!.unpublished, [firstEdit]);
    const editFunding = await deposit();
    assert.ok(!editFunding.fundingUtxos.some((u) => u.txid === anchorSent.revealTxId), 'the deposit offers no inscribed output');
    state = await engine.inscribe({ funding: editFunding });
    const editSent = state.anchoring!.lastSent!;
    assert.equal(editSent.versionId, firstEdit);
    const editReveal = await rpc<{ vin: Array<{ txid: string; vout: number }> }>('getrawtransaction', [editSent.commitTxId, true]);
    assert.deepEqual(editReveal.vin[0], { ...editReveal.vin[0], txid: anchorSent.revealTxId, vout: 0 });
    await env.mine(1);
    status = (await engine.anchoringStatus()).anchoring!.status!;
    assert.equal(status.heads.accepted, firstEdit);
    record('reinscribed', { entry: firstEdit, inputZero: `${anchorSent.revealTxId}:0`, commit: editSent.commitTxId, reveal: editSent.revealTxId });

    // 3. Kill the server between commit and reveal; a fresh one resumes the same pair.
    state = await engine.update('Harbor at dusk', 'Orbits', generateArtwork('Harbor at dusk', 'Orbits', 9).svg);
    const secondEdit = state.history.at(-1)!.versionId;
    const held = proxy.hold();
    const inFlight = engine.inscribe({ funding: await deposit() }).then(() => 'answered', (e: unknown) => e);
    const heldReveal = await held;
    const recoveryRoot = join(dataDir, 'originals-anchoring', SUB);
    const [originalDir] = await readdir(recoveryRoot);
    const recoveryDir = join(recoveryRoot, originalDir, 'recovery');
    const records = await Promise.all((await readdir(recoveryDir)).filter((f) => f.endsWith('.json')).map(async (f) => JSON.parse(await readFile(join(recoveryDir, f), 'utf8')) as { recoveryId: string; broadcast: string; prepared: { revealTxId: string; revealTxHex: string; commitTxId: string } }));
    const pending = records.find((r) => r.prepared.revealTxId === heldReveal);
    assert.ok(pending, 'the pair is on disk before its reveal is sent');
    landing.kill('SIGKILL');
    const killedWith = await landing.exited;
    const browserSaw = await inFlight;
    assert.ok(browserSaw instanceof Error, 'the browser lost the answer');
    assert.ok(await outbox.get(state.did), 'the browser keeps the pair it handed over');
    const pool = await mempool();
    assert.ok(pool.includes(pending.prepared.commitTxId) && !pool.includes(pending.prepared.revealTxId), 'commit out, reveal not');
    await env.mine(1);
    // A fresh reader of the sat: the pending pair does not advance the accepted head (P9.4).
    const satRead = await provider.getSatSnapshot(sat.sat, { bodies: 'originals' });
    const lastInscribed = new TextDecoder().decode(satRead.publications.at(-1)!.body.status === 'complete' ? (satRead.publications.at(-1)!.body as { bytes: Uint8Array }).bytes : new Uint8Array());
    assert.equal((JSON.parse(lastInscribed) as { versionId: string }).versionId, firstEdit);
    record('killed-between-commit-and-reveal', { entry: secondEdit, recoveryId: pending.recoveryId, recordState: pending.broadcast, killedExit: killedWith, signal: landing.signalCode ?? 'SIGKILL', commitMined: true, revealSent: false, acceptedHeadStill: firstEdit });

    proxy.release();
    landing = await startLanding();
    await until('the restarted server resuming the reveal', async () => (await mempool()).includes(pending.prepared.revealTxId), 60_000);
    const resentHex = await rpc<string>('getrawtransaction', [pending.prepared.revealTxId]);
    assert.equal(resentHex, pending.prepared.revealTxHex, 'the identical reveal');
    // New consumer engine, with no author or wallet signer: recover from the
    // authenticated server library and resend the same outbox pair (P9.6).
    const library = await getJson<{ originals: Array<{ did: string }> }>('/api/originals');
    assert.ok(library.originals.some((o) => o.did === state.did));
    const reopenedZip = new Uint8Array(await (await browserFetch(`/api/originals/evidence?did=${encodeURIComponent(state.did)}`)).arrayBuffer());
    const reopened = new DemoEngine({ authed: true, subOrgId: SUB, features: { bitcoinAnchoring: true }, anchoring: { transport, outbox, network: 'regtest', index: SERVER_INDEX } });
    await reopened.importEvidence(reopenedZip, state.did);
    const retried = await reopened.inscribe();
    assert.equal(retried.anchoring!.lastSent!.outcome, 'recorded');
    assert.equal(retried.anchoring!.lastSent!.commitTxId, pending.prepared.commitTxId);
    assert.equal(await outbox.get(state.did), undefined);
    await env.mine(1);
    status = (await engine.anchoringStatus()).anchoring!.status!;
    assert.equal(status.heads.accepted, secondEdit);
    const serverLog = await readFile(serverLogs.at(-1)!, 'utf8');
    assert.match(serverLog, /originals_anchor_resumed/);
    record('reopened-from-account-library', { did: state.did, entries: retried.history.length, author: retried.author, signer: 'none', identicalPair: true });
    record('resumed-by-a-fresh-server', { reveal: pending.prepared.revealTxId, identicalBytes: true, browserRetry: 'recorded', acceptedHead: secondEdit });

    // 4. Reorg the reveal out and back.
    const revealTx = await rpc<{ blockhash: string }>('getrawtransaction', [pending.prepared.revealTxId, true]);
    const oldTip = (await rpc<{ blocks: number }>('getblockchaininfo')).blocks;
    await rpc('invalidateblock', [revealTx.blockhash]);
    // Empty blocks until the new chain is longer than the old one, so ord follows the reorg;
    // the reveal waits in the mempool.
    while ((await rpc<{ blocks: number }>('getblockchaininfo')).blocks <= oldTip) await rpc('generateblock', [wallet.address, []]);
    await env.sync();
    status = (await engine.anchoringStatus()).anchoring!.status!;
    assert.equal(status.heads.accepted, firstEdit, 'the head goes back with the block');
    const duringReorg = { publication: status.publication, action: status.action };
    await env.mine(1);
    status = (await engine.anchoringStatus()).anchoring!.status!;
    assert.equal(status.heads.accepted, secondEdit, 'and forward again with the next');
    record('reorg', { invalidated: revealTx.blockhash, duringReorg, after: status.heads.accepted });
    await env.mine(2);

    // 5. A fresh reader: an empty store, no author list, the package and the sat.
    const zip = new Uint8Array(await (await browserFetch(`/api/originals/evidence?did=${encodeURIComponent(state.did)}`)).arrayBuffer());
    const freshEngine = new DemoEngine({ authed: true, subOrgId: SUB, anchoring: { transport, outbox, network: 'regtest', index: SERVER_INDEX } });
    await freshEngine.importEvidence(zip, state.did);
    const consumer = await freshEngine.verifyBitcoin();
    assert.equal(consumer.bitcoinVerification?.head, secondEdit);
    assert.equal(consumer.bitcoinVerification?.resources.status, 'available');
    record('fresh-consumer-reopen', { did: consumer.did, head: consumer.bitcoinVerification?.head, resources: consumer.bitcoinVerification?.resources.status, history: consumer.bitcoinVerification?.history.status, authorBinding: consumer.bitcoinVerification?.authorBinding.status, signer: 'none', index: SERVER_INDEX });
    const reader = OriginalsSDK.create({ store: await FileStore.open(await mkdtemp(join(tmpdir(), 'landing-reader-'))), authors: [] });
    const snapshot = await provider.getSatSnapshot(sat.sat, { bodies: 'originals' });
    const satpoint = snapshot.ownership.satpoint!;
    const ownerConfirmations = (await provider.getTransactionStatus(satpoint.split(':')[0])).confirmations ?? 0;
    const evidence = await satEvidence(snapshot, { clock: headerClock(rpc), ownerConfirmations, index: ORD_INDEX });
    const loaded = await reader.load(zip, { bitcoin: [evidence] });
    const r = loaded.report;
    assert.equal(r.history.status, 'valid');
    assert.equal(r.authorBinding.status, 'valid');
    assert.equal(r.anchoring?.status, 'anchored');
    assert.equal(r.head, secondEdit);
    assert.equal(r.ownership?.status, 'provisional');
    assert.equal(r.ownership?.output, `${pending.prepared.revealTxId}:0`);
    const contents = readEvidence(zip);
    const artwork = generateArtwork('Harbor at dusk', 'Orbits', 9).svg;
    const versions = r.resources.versions.map((v) => ({ resource: v.resource, version: v.version, bytes: v.bytes, sha256: contents.bytes[v.digest] ? hex.encode(sha256(contents.bytes[v.digest])) : null }));
    const latestArt = versions.filter((v) => v.resource === 'artwork.svg').at(-1)!;
    assert.equal(latestArt.sha256, hex.encode(sha256(new TextEncoder().encode(artwork))));
    const alone = await verifyOriginal({ bitcoin: [evidence], authors: contents.authors.map(({ retrievedFrom: _, ...a }) => a), now: Date.now() });
    assert.equal(alone.anchoring?.status, 'anchored');
    assert.equal(alone.head, secondEdit);
    record('fresh-reader', {
      network: snapshot.network, index: evidence.index, indexesConsulted: 1, history: r.history.status, authorBinding: r.authorBinding.status,
      identity: r.identityEvidence.status, head: r.head, current: r.current, ownership: r.ownership, resources: versions, fromBitcoinAlone: { copy: alone.anchoring?.copy, head: alone.head },
    });

    const receipt = {
      journey: 'landing-anchor', plan: 'plan 011 PR 10b', issue: '#975',
      revision: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(),
      dirty: (await Bun.$`git -C ${root} status --porcelain`.text()).trim().length > 0,
      versions: env.versions,
      network: 'regtest',
      server: { entry: 'apps/landing/serve.ts', processes: generation, index: SERVER_INDEX, indexesCompared: false, recoveryStore: 'fileRecoveryStore (per Original, on disk)' },
      browser: { entry: 'apps/landing/src/sdk/engine.ts (DemoEngine) in the journey process', outbox: 'memory' },
      signers: { author: 'local did:vh key (not the Turnkey did:webvh #key-1)', commit: 'local P2WPKH key (not Turnkey)', reveal: 'SDK ephemeral key' },
      liveTurnkeySigning: 'not exercised here: #975 stage A',
      faultInjection: 'Core RPC proxy held the reveal broadcast; the server process was SIGKILLed',
      steps,
    };
    const out = JSON.stringify(receipt, null, 2);
    console.log(out);
    if (process.env.ORIGINALS_REGTEST_LANDING_EVIDENCE) await writeFile(process.env.ORIGINALS_REGTEST_LANDING_EVIDENCE, out);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    for (const s of servers) s.stop(true);
    await env.stop();
  }
}

await main();
