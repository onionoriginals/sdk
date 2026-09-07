/** A separate, disposable process using the production routes and disk stores. */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { ed25519 } from '@noble/curves/ed25519.js';
import { RegtestProvider } from '@originals/sdk';
import { verifyToken } from '@originals/auth/server';
import { extractToken } from '../../server/cookies';
import { buildFetch } from '../../server/app';
import { createBitcoinRoutes } from '../../server/bitcoin';
import { createInscriptionsStore } from '../../server/inscriptions-store';
import { createOriginalsStore } from '../../server/originals-store';
import { createOriginalsRoutes } from '../../server/originals-routes';
import { createWebvhHostStore } from '../../server/webvh-host';
import { regtestIndexer, regtestOrdinalLookup } from '../../server/regtest';

export interface FixtureConfig {
  dataDir: string; distDir: string; rpcUrl: string; ordUrl: string; rpcAuth: string;
  origin: string; certPath: string; keyPath: string; jwtSecret: string;
  subOrgId: string; email: string; fundingAddress: string; authorshipAddress: string;
  fundingKey: string; authorshipKey: string;
  fault: 'commit-response-lost' | 'reveal-rejected';
}
const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as FixtureConfig;
const audit = (event: Record<string, unknown>) => appendFileSync(join(config.dataDir, 'browser-server-audit.jsonl'), JSON.stringify({ ...event, pid: process.pid, at: new Date().toISOString() }) + '\n');
const nativeFetch = globalThis.fetch;
const allowed = new Set([config.rpcUrl, config.ordUrl, config.origin]);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!allowed.has(url.origin)) {
    audit({ event: 'blocked-external-request', origin: url.origin });
    throw new Error(`Regtest server refused external origin ${url.origin}`);
  }
  return nativeFetch(input, { ...init, redirect: 'error' });
}) as typeof fetch;
const provider = new RegtestProvider(config);
const inscriptions = createInscriptionsStore({ dataDir: config.dataDir });
const faultMarker = join(config.dataDir, 'browser-fault-fired');
const submitted = new Proxy(provider, {
  get(target, property) {
    if (property === 'broadcastTransaction') return async (raw: string) => {
      // Re-open from disk here, so this proves durable persistence rather than
      // trusting an in-memory object handed to the route under test.
      const record = createInscriptionsStore({ dataDir: config.dataDir }).list(config.subOrgId)
        .find(value => value.signedCommitHex === raw || value.revealTxHex === raw);
      assert.ok(record?.signedCommitHex && record.revealTxHex, 'both signed transactions must be on disk before broadcast');
      const kind = record.signedCommitHex === raw ? 'commit' : 'reveal';
      audit({ event: 'broadcast', kind, commitTxId: record.commitTxId, revealTxId: record.revealTxId,
        rawSha256: createHash('sha256').update(Buffer.from(raw, 'hex')).digest('hex'), pairPersisted: true });
      let inject = false;
      if (config.fault === 'commit-response-lost' ? kind === 'commit' : kind === 'reveal') {
        try { writeFileSync(faultMarker, config.fault, { flag: 'wx' }); inject = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (inject) {
        if (config.fault === 'commit-response-lost') await target.broadcastTransaction(raw);
        audit({ event: 'fault', fault: config.fault });
        throw new Error(`Disposable local fault: ${config.fault}`);
      }
      return target.broadcastTransaction(raw);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const indexer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: regtestIndexer(provider) });
allowed.add(indexer.url.origin);
const bitcoin = createBitcoinRoutes({ jwtSecret: config.jwtSecret, network: 'regtest', provider: submitted,
  inscriptions, indexer: { api: indexer.url.origin }, ordinals: regtestOrdinalLookup(provider) });
const originalsStore = createOriginalsStore({ dataDir: config.dataDir });
const originals = createOriginalsRoutes({ jwtSecret: config.jwtSecret, store: originalsStore });
const handler = buildFetch({
  apiRoutes: {
    'GET /api/btc/network': bitcoin.networkInfo,
    'GET /api/btc/deposit': bitcoin.deposit, 'POST /api/btc/fee': bitcoin.fee,
    'POST /api/btc/sat': bitcoin.sat, 'GET /api/btc/prevtx': bitcoin.prevTx,
    'POST /api/btc/inscribe': bitcoin.inscribe, 'GET /api/btc/inscribe': bitcoin.inscribeList,
    'POST /api/btc/inscribe/rebroadcast': bitcoin.inscribeRebroadcast,
    'GET /api/btc/sat-snapshot/:sat': bitcoin.satSnapshot,
    'POST /api/originals': originals.record, 'GET /api/originals': originals.list,
  }, originals, publications: originalsStore, hostStore: createWebvhHostStore(),
  distDir: config.distDir, log: message => audit({ event: 'http', message }),
});
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(new URL(config.origin).port),
  tls: { cert: Bun.file(config.certPath), key: Bun.file(config.keyPath) },
  async fetch(request, instance) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/__regtest/')) return handler(request, instance);
    const token = extractToken(request);
    let subject: string | undefined;
    try { subject = token ? verifyToken(token, { secret: config.jwtSecret }).sub : undefined; } catch { /* fail closed */ }
    if (subject !== config.subOrgId) return new Response('Unauthenticated fixture request', { status: 401 });
    if (path === '/__regtest/session' && request.method === 'GET') {
      const { subOrgId, email, fundingAddress, authorshipAddress } = config;
      return Response.json({ subOrgId, email, fundingAddress, authorshipAddress });
    }
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    audit({ event: 'sign-request', operation: path });
    if (existsSync(join(config.dataDir, 'browser-signing-disabled'))) {
      return new Response('Signing disabled: recovery must reuse the stored pair', { status: 503 });
    }
    if (path === '/__regtest/sign-transaction') {
      const params = await request.json() as { unsignedTransaction: string; type: string };
      assert.equal(params.type, 'TRANSACTION_TYPE_BITCOIN');
      const tx = btc.Transaction.fromPSBT(Buffer.from(params.unsignedTransaction, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
      tx.sign(Buffer.from(config.fundingKey, 'hex'));
      return Response.json({ signedTransaction: Buffer.from(tx.toPSBT()).toString('hex') });
    }
    if (path === '/__regtest/sign-payload') {
      const params = await request.json() as { payload: string; signWith: string; organizationId: string; encoding: string; hashFunction: string };
      assert.equal(params.signWith, config.authorshipAddress);
      assert.equal(params.organizationId, config.subOrgId);
      assert.equal(params.encoding, 'PAYLOAD_ENCODING_HEXADECIMAL');
      assert.equal(params.hashFunction, 'HASH_FUNCTION_NOT_APPLICABLE');
      const signature = Buffer.from(ed25519.sign(Buffer.from(params.payload.replace(/^0x/, ''), 'hex'), Buffer.from(config.authorshipKey, 'hex'))).toString('hex');
      return Response.json({ activity: { result: { signRawPayloadResult: { r: signature.slice(0, 64), s: signature.slice(64) } } } });
    }
    return new Response('Not found', { status: 404 });
  },
});
audit({ event: 'server-started', origin: config.origin });
const stop = () => { server.stop(true); indexer.stop(true); process.exit(0); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
