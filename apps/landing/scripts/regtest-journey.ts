import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { RegtestProvider, OriginalsSDK, createLocalSigner, parseDocument, type OriginalsAsset, type PreparedBitcoinPublication } from '@originals/sdk';
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
import { startRegtest } from '../../../scripts/regtest/environment';

const hashResource = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const env = await startRegtest();
let app: ReturnType<typeof Bun.serve> | undefined;
let indexer: ReturnType<typeof Bun.serve> | undefined;
const nativeFetch = globalThis.fetch;
const checkpoint = (stage: string) => console.log(JSON.stringify({ stage, at: new Date().toISOString() }));
try {
  const provider = new RegtestProvider(env);
  const fault = process.env.REGTEST_FAULT ?? 'none';
  if (!['none', 'reveal-rejected', 'commit-response-lost'].includes(fault)) throw new Error('Unknown regtest fault');
  let broadcastCount = 0;
  const submittedProvider = new Proxy(provider, {
    get(target, property) {
      if (property === 'broadcastTransaction') return async (raw: unknown) => {
        broadcastCount++;
        const persisted = store().list(sub).find(record => record.signedCommitHex === raw || record.revealTxHex === raw);
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
  let sweepInscriptions: ReturnType<typeof createBitcoinRoutes>['sweepInscriptions'];
  const routes = () => {
    const b = createBitcoinRoutes({ jwtSecret, provider: submittedProvider, network: 'regtest', indexer: { api: indexer!.url.origin },
      ordinals: regtestOrdinalLookup(provider), inscriptions: store() });
    sweepInscriptions = b.sweepInscriptions;
    return { 'GET /api/btc/deposit': b.deposit, 'POST /api/btc/fee': b.fee, 'POST /api/btc/sat': b.sat,
      'GET /api/btc/prevtx': b.prevTx, 'POST /api/btc/inscribe': b.inscribe, 'GET /api/btc/inscribe': b.inscribeList,
      'POST /api/btc/inscribe/rebroadcast': b.inscribeRebroadcast, 'GET /api/btc/sat-snapshot/:sat': b.satSnapshot };
  };
  // A fresh, explicitly trusted loopback certificate; no system trust changes
  // and no TLS verification bypass. did:webvh still resolves over real HTTPS.
  const certPath = join(env.dataDir, 'localhost.crt');
  const keyPath = join(env.dataDir, 'localhost.key');
  const configPath = join(env.dataDir, 'localhost.cnf');
  await writeFile(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=regtest.localhost\n[ext]\nsubjectAltName=DNS:regtest.localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  const certCommand = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', configPath, '-keyout', keyPath, '-out', certPath], { stdout: 'ignore', stderr: 'pipe' });
  if (await certCommand.exited) throw new Error(await new Response(certCommand.stderr).text());
  const ca = await readFile(certPath, 'utf8');
  const hostStore = createWebvhHostStore();
  let handler = buildFetch({ apiRoutes: routes(), hostStore, distDir: join(env.dataDir, 'unused/'), log: () => {} });
  app = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(keyPath), cert: ca }, fetch: req => handler(req) });
  const origin = `https://regtest.localhost:${app.port}`;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return nativeFetch(input, url.origin === origin ? { ...init, redirect: 'error', tls: { ca } } : init);
  }) as typeof fetch;
  const browserFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('cookie', cookie);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
  const httpProvider = new HttpOrdinalsProvider({ baseUrl: origin, fetchImpl: browserFetch });
  const controller = createLocalSigner('Ed25519', new Uint8Array(32).fill(7));
  const nextController = createLocalSigner('Ed25519', new Uint8Array(32).fill(8));
  const storageAdapter = new HttpHostingStorageAdapter({ baseUrl: origin, fetchImpl: browserFetch });
  const sdk = OriginalsSDK.create({ network: 'regtest', signer: controller, ordinalsProvider: httpProvider,
    storageAdapter, enableLogging: false, logging: { level: 'error' } });
  const cold = () => OriginalsSDK.create({ network: 'regtest', ordinalsProvider: provider,
    storageAdapter: new HttpHostingStorageAdapter({ baseUrl: origin }), enableLogging: false, logging: { level: 'error' } });
  const png = process.env.REGTEST_PNG ? new Uint8Array(await readFile(process.env.REGTEST_PNG)) : new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
  assert.deepEqual(png.slice(0, 8), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'PNG signature');
  assert.ok(png.length <= 256 * 1024, 'PNG must fit the local host 256 KiB object limit');
  const local = await sdk.lifecycle.createAsset([{ id: 'art.png', mediaType: 'image/png', content: png }]);
  checkpoint('publish-hosted');
  const published = await sdk.lifecycle.publishToWeb(local, { domain: new URL(origin).host });
  const webDid = published.did;
  assert.equal(local.state.layer, 'cel', 'publication returns a new asset without changing local identity');
  const freshWeb = await cold().lifecycle.resolveAssetFromWeb(webDid);
  assert.equal(freshWeb.verification.verified, true, 'fresh HTTPS method and CEL binding');
  assert.deepEqual(freshWeb.asset.resources[0].content, png, 'fresh HTTP resource bytes');
  const depositRes = await browserFetch(`${origin}/api/btc/deposit?address=${address}&contentBytes=${png.length + 8000}`);
  assert.equal(depositRes.status, 200, await depositRes.clone().text());
  const deposit = await depositRes.json() as { confirmedUtxos: Array<{ txid: string; vout: number; value: number; scriptPubKey?: string }> };
  assert.ok(deposit.confirmedUtxos.length);
  const picked = [deposit.confirmedUtxos[0]];
  const expectedSat = await provider.getFirstSatOfOutput(picked[0]);
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
  console.log(JSON.stringify({ stage: 'boundary-input', expectedSat, funding: picked[0], snapshot: await httpProvider.getSatSnapshot(expectedSat) }));
  const prepared = await sdk.lifecycle.prepareBitcoinPublication(published.asset, {
    fundingUtxos: picked, changeAddress: address, feeRate, satSigner: signer,
  });
  assert.equal(broadcastCount, 0, 'preparation never broadcasts');
  assert.equal(prepared.kind, 'boundary');
  assert.equal(prepared.document.log.length, 3);
  const assertInscription = async (publication: PreparedBitcoinPublication, media?: Uint8Array) => {
    const observed = await provider.getInscriptionById(publication.transactions.inscriptionId);
    assert.ok(observed, 'ord returns the mined inscription');
    assert.equal(observed.satoshi, expectedSat);
    if (media) {
      assert.deepEqual(observed.content, media, 'ord serves exact raw media');
      assert.deepEqual(observed.metadata, publication.document, 'CEL document occupies CBOR metadata');
    } else {
      assert.equal(observed.contentType, 'application/cel');
      assert.equal(observed.metadata, undefined);
      assert.deepEqual(parseDocument(observed.content, 'json'), publication.document);
    }
  };
  const preparedPath = join(env.dataDir, 'prepared-boundary.json');
  await writeFile(preparedPath, JSON.stringify(prepared));
  const submitted = await sdk.lifecycle.publishPreparedToBitcoin(JSON.parse(await readFile(preparedPath, 'utf8')));
  const saved = store().get(sub, prepared.transactions.commitTxId);
  assert.ok(saved?.signedCommitHex && saved.revealTxHex, 'pair persisted before the first broadcast');
  assert.equal(saved.signedCommitHex, prepared.transactions.signedCommitHex);
  assert.equal(saved.revealTxHex, prepared.transactions.revealTxHex);
  const submit = { commitTxId: saved.commitTxId, revealTxId: saved.revealTxId, inscriptionId: saved.inscriptionId };
  assert.equal(submitted.submission.broadcast, fault === 'none' ? 'reveal_broadcast' : fault === 'reveal-rejected' ? 'commit_broadcast' : 'commit_broadcast_unknown');
  handler = buildFetch({ apiRoutes: routes(), hostStore, distDir: join(env.dataDir, 'unused/'), log: () => {} });
  if (fault === 'reveal-rejected') {
    // The sweep completes a confirmed stranded commit immediately; unconfirmed
    // attempts keep the production rebroadcast backoff.
    await env.mine();
    const swept = await sweepInscriptions!();
    assert.equal(swept.unreadable.length, 0);
    assert.equal(store().get(sub, submit.commitTxId)?.status, 'reveal_broadcast', 'closed-browser sweep recovers rejected reveal');
  } else if (fault === 'commit-response-lost') {
    const retry = await browserFetch(`${origin}/api/btc/inscribe/rebroadcast`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commitTxId: submit.commitTxId }),
    });
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal((await retry.json() as { status: string }).status, 'reveal_broadcast');
  }
  checkpoint('mine-boundary');
  const [block] = await env.mine();
  const listed = await (await browserFetch(`${origin}/api/btc/inscribe`)).json() as { inscriptions: Array<{ status: string }> };
  assert.equal(listed.inscriptions[0].status, 'confirmed');
  assert.ok(store().get(sub, submit.commitTxId)?.revealTxHex, 'one confirmation retains recovery bytes');
  const readAccepted = async () => {
    const result = await cold().lifecycle.resolveAssetFromSat(expectedSat);
    assert.equal(result.status, 'accepted', JSON.stringify(result));

    assert.equal(result.verification.verified, true, 'fresh accepted history and all resource bytes');
    return result;
  };
  await assertInscription(prepared, png);
  const beforeReorg = await readAccepted();
  assert.deepEqual(beforeReorg.asset.resources[0].content, png);
  const btcoDid = beforeReorg.asset.state.alias;
  assert.equal((await cold().did.resolveDID(btcoDid))?.id, btcoDid);
  checkpoint('invalidate-boundary');
  await env.rpc('invalidateblock', [block]);
  assert.equal((await provider.getTransactionStatus(submit.revealTxId)).confirmed, false);
  // ord may wait for a replacement block before rolling its index back. The
  // resolver must still refuse the stale index immediately after invalidation.
  const orphaned = await cold().lifecycle.resolveAssetFromSat(expectedSat);
  assert.notEqual(orphaned.status, 'accepted', 'orphaned boundary cannot remain accepted');
  const reorganized = await (await browserFetch(`${origin}/api/btc/inscribe`)).json() as { inscriptions: Array<{ status: string }> };
  assert.equal(reorganized.inscriptions[0].status, 'reveal_broadcast', 'reorg demotes confirmation');
  await env.rpc('setmocktime', [Math.floor(Date.now() / 1000) + 600]);
  checkpoint('reconfirm-boundary');
  await env.mine(2);
  const recovered = await readAccepted();
  assert.equal(recovered.asset.state.head, beforeReorg.asset.state.head);
  assert.deepEqual((await cold().lifecycle.loadAsset(JSON.stringify(recovered.asset.serialize()))).asset.resources[0].content, png);
  await env.mine(4);
  await sweepInscriptions!();
  assert.equal(store().get(sub, submit.commitTxId)?.retired, true, 'six confirmations retire pair bytes');
  const publications = [submit.inscriptionId];
  let lastPublicationBlock = '';
  const publishDelta = async (asset: OriginalsAsset, expectedEntries: number, media?: Uint8Array) => {
    const ownership = await provider.getSatOwnership(expectedSat);
    assert.ok(ownership);
    const [txid, vout] = ownership.outpoint.split(':');
    const output = await provider.getOutputDetails(ownership.outpoint);
    await env.fund(address);
    const funding = (await provider.getAddressUtxos(address)).find(utxo => utxo.txid !== txid && utxo.value >= 100_000);
    assert.ok(funding);
    const proposal = await sdk.lifecycle.prepareBitcoinPublication(asset, { fundingUtxos: [
      { txid, vout: Number(vout), value: output.value, scriptPubKey: output.script_pubkey }, funding,
    ], changeAddress: address, feeRate, satSigner: signer });
    assert.equal(proposal.kind, 'delta');
    assert.equal(proposal.document.log.length, expectedEntries, 'only entries after freshly observed accepted head');
    const response = await sdk.lifecycle.publishPreparedToBitcoin(JSON.parse(JSON.stringify(proposal)));
    assert.equal(response.submission.broadcast, 'reveal_broadcast');
    [lastPublicationBlock] = await env.mine();
    await assertInscription(proposal, media);
    publications.push(proposal.transactions.inscriptionId);
    return readAccepted();
  };
  checkpoint('rotate-controller');
  await recovered.asset.rotateKey(nextController.controller, { signer: controller });
  await recovered.asset.update({ name: 'rotated on real regtest' }, { signer: nextController });
  let rotated = await publishDelta(recovered.asset, 2);
  assert.equal(rotated.asset.state.controller, nextController.controller);
  assert.equal(rotated.asset.state.name, 'rotated on real regtest');
  const didResolution = await cold().did.resolveDIDWithMetadata(btcoDid);
  assert.equal(didResolution.didDocumentMetadata.head, rotated.asset.state.head);
  await assert.rejects(rotated.asset.update({ name: 'retired signer' }, { signer: controller }));
  checkpoint('orphan-rotation');
  const orphanedRotationBlock = lastPublicationBlock;
  await env.rpc('invalidateblock', [orphanedRotationBlock]);
  // Mine an explicitly empty replacement branch so the orphaned signed delta
  // remains in the mempool while ord recomputes the accepted prefix.
  const replacementAddress = await env.rpc<string>('getnewaddress', ['', 'bech32'], 'originals-regtest');
  await env.rpc('generateblock', [replacementAddress, []]);
  await env.rpc('generateblock', [replacementAddress, []]);
  await env.sync();
  const beforeRotation = await readAccepted();
  assert.equal(beforeRotation.asset.state.controller, controller.controller, 'orphaned rotation restores prior current controller');
  assert.equal(beforeRotation.asset.state.head, beforeReorg.asset.state.head);
  await env.mine();
  rotated = await readAccepted();
  assert.equal(rotated.asset.state.controller, nextController.controller, 'reconfirmed rotation retires old controller again');
  const buyerKey = secp256k1.utils.randomSecretKey();
  const payment = (key: Uint8Array) => btc.p2wpkh(secp256k1.getPublicKey(key, true), { ...btc.TEST_NETWORK, bech32: 'bcrt' });
  const buyerAddress = payment(buyerKey).address!;
  const moveSat = async (fromKey: Uint8Array, toKey: Uint8Array) => {
    const from = payment(fromKey), to = payment(toKey);
    const ownership = await provider.getSatOwnership(expectedSat);
    assert.ok(ownership);
    const output = await provider.getOutputDetails(ownership.outpoint);
    await env.fund(from.address!);
    const funding = (await provider.getAddressUtxos(from.address!)).find(utxo => utxo.value >= 100_000 && `${utxo.txid}:${utxo.vout}` !== ownership.outpoint);
    assert.ok(funding);
    const [txid, vout] = ownership.outpoint.split(':');
    const transfer = new btc.Transaction();
    transfer.addInput({ txid, index: Number(vout), witnessUtxo: { script: from.script, amount: BigInt(output.value) } });
    transfer.addInput({ txid: funding.txid, index: funding.vout, witnessUtxo: { script: from.script, amount: BigInt(funding.value) } });
    transfer.addOutput({ script: to.script, amount: BigInt(output.value) });
    transfer.addOutput({ script: from.script, amount: BigInt(funding.value - 1000) });
    transfer.sign(fromKey); transfer.finalize();
    const transferTxid = await provider.broadcastTransaction(transfer.hex);
    await env.mine();
    const moved = await readAccepted();
    assert.equal(moved.asset.state.head, rotated.asset.state.head, 'sat move adds no CEL entry');
    assert.equal(moved.asset.state.controller, nextController.controller, 'possession does not change controller authority');
    assert.equal(moved.resolution.ownership.owner, to.address);
    await assert.rejects(moved.asset.update({ name: 'retired key after sat move' }, { signer: controller }));
    return transferTxid;
  };
  checkpoint('sale-and-reacquisition');
  const saleTxid = await moveSat(privateKey, buyerKey);
  const reacquisitionTxid = await moveSat(buyerKey, privateKey);
  checkpoint('resource-version');
  const updatedPng = new Uint8Array([...png, 0, 255]);
  await rotated.asset.addResourceVersion('art.png', updatedPng, 'image/png', { signer: nextController });
  const updated = await publishDelta(rotated.asset, 1, updatedPng);
  assert.equal(updated.asset.state.resources[0].version, 2);
  assert.deepEqual(updated.asset.resources.find(resource => resource.version === 1)?.content, png);
  assert.deepEqual(updated.asset.resources.find(resource => resource.version === 2)?.content, updatedPng);
  checkpoint('deactivation');
  await updated.asset.deactivate('regtest release qualification', { signer: nextController });
  const deactivated = await publishDelta(updated.asset, 1);
  assert.equal(deactivated.asset.state.active, false);
  assert.equal(await cold().did.resolveDID(btcoDid), null);
  assert.equal((await cold().did.resolveDIDWithMetadata(btcoDid)).didDocumentMetadata.deactivated, true);
  const receipt = { result: 'pass', format: 'originals/cel/3', chain: 'regtest', fault, ...env.versions, did: btcoDid,
    webDid, ...submit, publications, saleTxid, reacquisitionTxid, buyerAddress, orphanedRotationBlock, orphanedBlock: block, activeTip: await env.rpc('getbestblockhash'), pngBytes: png.length,
    pngHash: hashResource(png), dataDir: env.dataDir, finalHead: deactivated.asset.state.head,
    checks: ['explicit HTTPS WebVH method and CEL publication', 'cold hosted PNG bytes', 'HTTP deposit/fee/sat/prevtx',
      'zero-broadcast preparation', 'raw PNG plus full boundary CBOR', 'persist exact signed pair before broadcast',
      'route/store recreation from disk', 'selected sat preserved', 'orphaned boundary rejected after real reorg',
      'reconfirmation', 'cold sat bytes and DID authority', 'CEL 3 JSON reload', 'six-confirmation retention horizon',
      'cold accepted-head delta', 'one-publication rotation plus new-controller update', 'retired controller rejected',
      'orphaned rotation restores prior controller', 'real sat sale and reacquisition preserve CEL head and authority', 'closed-browser recovery sweep',
      'new-resource raw media delta', 'historical and current resource bytes', 'log-only deactivation', 'deactivated DID metadata'],
    signer: 'disposable local Bitcoin key through TurnkeySatSigner; disposable CEL keys; no Turnkey service call' };
  await writeFile(join(env.dataDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  if (process.env.REGTEST_RECEIPT) await writeFile(process.env.REGTEST_RECEIPT, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { globalThis.fetch = nativeFetch; app?.stop(true); indexer?.stop(true); await env.stop(); }
