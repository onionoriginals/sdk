import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { RegtestProvider } from '@originals/sdk';
import { OriginalsSDK } from '../src/sdk/previous-sdk';
import type { TurnkeyBitcoinClient } from '../src/auth/turnkey-session';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../server/cookies';
import { createBitcoinRoutes } from '../server/bitcoin';
import { createInscriptionsStore } from '../server/inscriptions-store';
import { createWebvhHostStore } from '../server/webvh-host';
import { buildFetch } from '../server/app';
import { regtestIndexer, regtestOrdinalLookup } from '../server/regtest';
import { HttpOrdinalsProvider } from '../src/sdk/http-ordinals-provider';
import { HttpHostingStorageAdapter } from '../src/sdk/http-hosting-adapter';
import { TurnkeySatSigner } from '../src/sdk/turnkey-sat-signer';
import { selectFundingUtxos, inscriptionContentBytes, type DepositInfo } from '../src/components/Demo';
import { startRegtest } from '../../../scripts/regtest/environment';

const hashResource = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const env = await startRegtest();
let app: ReturnType<typeof Bun.serve> | undefined;
let indexer: ReturnType<typeof Bun.serve> | undefined;
const nativeFetch = globalThis.fetch;
try {
  const provider = new RegtestProvider(env);
  const fault = process.env.REGTEST_FAULT ?? 'none';
  if (!['none', 'reveal-rejected', 'commit-response-lost'].includes(fault)) throw new Error('Unknown regtest fault');
  let broadcastCount = 0;
  const submittedProvider = new Proxy(provider, {
    get(target, property) {
      if (property === 'broadcastTransaction') return async (raw: unknown) => {
        broadcastCount++;
        const persisted = store().list(sub)[0];
        assert.ok(persisted?.signedCommitHex && persisted.revealTxHex, 'pair persisted before any broadcast');
        if (fault === 'reveal-rejected' && broadcastCount === 2) throw new Error('Local fault: reveal submission interrupted');
        const txid = await target.broadcastTransaction(raw);
        if (fault === 'commit-response-lost' && broadcastCount === 1) throw new Error('Local fault: commit accepted, response lost');
        return txid;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  indexer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: regtestIndexer(provider) });
  const privateKey = secp256k1.utils.randomSecretKey();
  const address = btc.p2wpkh(secp256k1.getPublicKey(privateKey, true), { ...btc.TEST_NETWORK, bech32: 'bcrt' }).address!;
  await env.fund(address);
  const jwtSecret = Buffer.from(secp256k1.utils.randomSecretKey()).toString('hex');
  const sub = 'local-regtest-creator';
  const cookie = serializeCookie(getAuthCookieConfig(signToken(sub, 'regtest@localhost', undefined, { secret: jwtSecret })));
  const store = () => createInscriptionsStore({ dataDir: env.dataDir });
  const routes = () => {
    const b = createBitcoinRoutes({ jwtSecret, provider: submittedProvider, network: 'regtest', indexer: { api: indexer!.url.origin },
      ordinals: regtestOrdinalLookup(provider), inscriptions: store() });
    return { 'GET /api/btc/deposit': b.deposit, 'POST /api/btc/fee': b.fee, 'POST /api/btc/sat': b.sat,
      'GET /api/btc/prevtx': b.prevTx, 'POST /api/btc/inscribe': b.inscribe, 'GET /api/btc/inscribe': b.inscribeList,
      'POST /api/btc/inscribe/rebroadcast': b.inscribeRebroadcast };
  };
  // A fresh, explicitly trusted loopback certificate; no system trust changes
  // and no TLS verification bypass. did:webvh still resolves over real HTTPS.
  const certPath = join(env.dataDir, 'localhost.crt');
  const keyPath = join(env.dataDir, 'localhost.key');
  const configPath = join(env.dataDir, 'localhost.cnf');
  await writeFile(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  const certCommand = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', configPath, '-keyout', keyPath, '-out', certPath], { stdout: 'ignore', stderr: 'pipe' });
  if (await certCommand.exited) throw new Error(await new Response(certCommand.stderr).text());
  const ca = await readFile(certPath, 'utf8');
  const hostStore = createWebvhHostStore();
  let handler = buildFetch({ apiRoutes: routes(), hostStore, distDir: join(env.dataDir, 'unused/'), log: () => {} });
  app = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(keyPath), cert: ca }, fetch: req => handler(req) });
  const origin = `https://localhost:${app.port}`;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return nativeFetch(input, url.origin === origin ? { ...init, redirect: 'error', tls: { ca } } : init);
  }) as typeof fetch;
  const browserFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('cookie', cookie);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
  const httpProvider = new HttpOrdinalsProvider({ baseUrl: origin, fetchImpl: browserFetch });
  const keys = new Map<string, string>();
  const sdk = OriginalsSDK.create({ network: 'regtest', webvhNetwork: 'magby', defaultKeyType: 'Ed25519', ordinalsProvider: httpProvider,
    storageAdapter: new HttpHostingStorageAdapter({ baseUrl: origin, fetchImpl: browserFetch }), enableLogging: false, logging: { level: 'error' },
    keyStore: { async getPrivateKey(id) { return keys.get(id) ?? null; }, async setPrivateKey(id, key) { keys.set(id, key); } },
  });
  const png = process.env.REGTEST_PNG ? new Uint8Array(await readFile(process.env.REGTEST_PNG)) : new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
  assert.deepEqual(png.slice(0, 8), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'PNG signature');
  assert.ok(png.length <= 256 * 1024, 'PNG must fit the local host 256 KiB object limit');
  const asset = await sdk.lifecycle.createAsset([{ id: 'art.png', type: 'image', contentType: 'image/png', content: png, hash: hashResource(png) }]);
  await sdk.lifecycle.publishToWeb(asset, new URL(origin).host);
  const webDid = asset.bindings!['did:webvh'];
  const freshWeb = OriginalsSDK.create({ network: 'regtest', webvhNetwork: 'magby', enableLogging: false, logging: { level: 'error' } });
  assert.equal((await freshWeb.did.resolveDID(webDid))?.id, webDid, 'fresh HTTPS DID resolution');
  const parts = webDid.split(':');
  const webPath = parts.slice(4).join('/');
  const resourceUrl = `${origin}/${webPath}/resources/${(await import('../src/sdk/previous-sdk')).resourcePathSegment(hashResource(png))}`;
  const served = await fetch(resourceUrl);
  assert.equal(served.status, 200);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png, 'HTTP host bytes');
  const contentBytes = inscriptionContentBytes({ resource: { content: png }, metadata: { content: '' }, celLog: asset.celLog?.events ?? [] });
  const depositRes = await browserFetch(`${origin}/api/btc/deposit?address=${address}&contentBytes=${contentBytes}`);
  assert.equal(depositRes.status, 200, await depositRes.clone().text());
  const deposit = await depositRes.json() as DepositInfo;
  const picked = selectFundingUtxos(deposit.confirmedUtxos, deposit.estimatedCostSats);
  assert.equal(picked.shortfallSats, 0);
  assert.ok(picked.selected.length);
  const expectedSat = await provider.getFirstSatOfOutput(picked.selected[0]);
  const feeRate = await httpProvider.estimateFee();
  assert.equal(feeRate, 2, 'explicit local fee through the HTTP route');
  const client = { async signTransaction({ unsignedTransaction }: { unsignedTransaction: string }) {
    const tx = btc.Transaction.fromPSBT(Buffer.from(unsignedTransaction, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
    tx.sign(privateKey); return { signedTransaction: Buffer.from(tx.toPSBT()).toString('hex') };
  } } as TurnkeyBitcoinClient;
  const signer = new TurnkeySatSigner({ client, signWith: address, async fetchRawTx(txid) {
    const res = await browserFetch(`${origin}/api/btc/prevtx?txid=${txid}`); assert.equal(res.status, 200);
    return (await res.json() as { hex: string }).hex;
  } });
  const inscribe = () => sdk.lifecycle.inscribeOnBitcoin(asset, { fundingUtxos: picked.selected, changeAddress: address, feeRate, satSigner: signer });
  if (fault === 'commit-response-lost') await assert.rejects(inscribe, /commit_broadcast_failed/);
  else await inscribe();
  const saved = store().list(sub)[0];
  assert.ok(saved?.signedCommitHex && saved.revealTxHex, 'pair persisted before the first broadcast');
  const submit = { commitTxId: saved.commitTxId, revealTxId: saved.revealTxId, inscriptionId: saved.inscriptionId };
  if (fault === 'reveal-rejected') assert.equal(httpProvider.lastSubmit?.status, 'commit_broadcast');
  if (fault === 'none') assert.equal(httpProvider.lastSubmit?.status, 'reveal_broadcast');
  // Reload every route/store instance from disk, as after an application restart.
  handler = buildFetch({ apiRoutes: routes(), hostStore, distDir: join(env.dataDir, 'unused/'), log: () => {} });
  if (fault !== 'none') {
    const retry = await browserFetch(`${origin}/api/btc/inscribe/rebroadcast`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commitTxId: submit.commitTxId }),
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { status: string }).status, 'reveal_broadcast');
  }
  const [block] = await env.mine();
  const list = await browserFetch(`${origin}/api/btc/inscribe`);
  const listed = await list.json() as any;
  assert.equal(listed.inscriptions[0].status, 'confirmed');
  assert.ok(store().get(sub, submit.commitTxId)?.revealTxHex, 'one confirmation must retain recovery bytes');
  await env.rpc('invalidateblock', [block]);
  assert.equal((await provider.getTransactionStatus(submit.revealTxId)).confirmed, false);
  const reorganized = await (await browserFetch(`${origin}/api/btc/inscribe`)).json() as any;
  assert.equal(reorganized.inscriptions[0].status, 'reveal_broadcast', 'reorg removes confirmation');
  await env.rpc('setmocktime', [Math.floor(Date.now() / 1000) + 600]);
  await env.mine(2);
  const inscription = await provider.getInscriptionById(submit.inscriptionId);
  assert.ok(inscription?.satoshi);
  const sat = inscription.satoshi;
  assert.equal(sat, expectedSat, 'the first selected funding sat carries the inscription');
  const btcoDid = `did:btco:reg:${sat}`;
  if (fault !== 'commit-response-lost') assert.equal(asset.bindings?.['did:btco'], btcoDid);
  const fresh = OriginalsSDK.create({ network: 'regtest', webvhNetwork: 'magby', ordinalsProvider: provider, enableLogging: false, logging: { level: 'error' } });
  const recovered = await fresh.lifecycle.resolveAssetFromSat(sat);
  assert.equal(recovered.verification?.verified, true);
  assert.deepEqual(recovered.asset.resources[0].content, png);
  const exported = JSON.stringify(recovered.asset.serialize());
  assert.deepEqual((await fresh.lifecycle.loadAsset(exported)).asset.resources[0].content, png);
  assert.equal((await fresh.did.resolveDID(btcoDid))?.id, btcoDid);
  await env.mine(5);
  await browserFetch(`${origin}/api/btc/inscribe`);
  assert.equal(store().get(sub, submit.commitTxId)?.retired, true);
  const receipt = { result: 'pass', chain: 'regtest', fault, ...env.versions, did: btcoDid,
    webDid, ...submit, orphanedBlock: block, activeTip: await env.rpc('getbestblockhash'), pngBytes: png.length, pngHash: hashResource(png), dataDir: env.dataDir,
    checks: ['HTTPS publication', 'fresh WebVH resolution', 'HTTP deposit/fee/sat/prevtx', 'SDK commit/reveal', 'persistence before broadcast', 'selected sat preserved', 'route/store recreation from disk', 'confirmation', 'one-block reorg and re-confirmation', 'fresh sat recovery', 'fresh btco DID resolution', 'v2 JSON reload', 'six-confirmation retention horizon'],
    signer: 'disposable local key through TurnkeySatSigner; no Turnkey service call' };
  await writeFile(join(env.dataDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  if (process.env.REGTEST_RECEIPT) await writeFile(process.env.REGTEST_RECEIPT, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { globalThis.fetch = nativeFetch; app?.stop(true); indexer?.stop(true); await env.stop(); }
