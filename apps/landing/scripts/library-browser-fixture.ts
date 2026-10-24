/** Local browser-check fixture. Simulated chain and local keys; no Turnkey,
 * credentials, public networks or deployment. Run on separate loopback ports:
 * bun apps/landing/scripts/library-browser-fixture.ts
 * LANDING_API_ORIGIN=http://127.0.0.1:3102 bun run --cwd apps/landing dev --port 3101
 */
import { prepareEntryInscription } from '@originals/sdk/originals/bitcoin';
import { base64 } from '@scure/base';
import { signToken } from '@originals/auth/server';
import { createOriginalsStore } from '../server/originals-store';
import { createOriginalsRoutes } from '../server/originals-routes';
import { createAnchoringLibrary } from '../server/originals-library';
import { inProcessLanding } from '../server/tests/landing-server-fixture';
import { authorWithOriginal, fakeChain, headerClock, INDEX, WALLET_ADDRESS, walletSigner } from '../server/tests/originals-chain-fixture';

const chain = fakeChain();
const landing = inProcessLanding(chain, 'alice');
const a = await authorWithOriginal();
const pair = await prepareEntryInscription({ sdk: a.sdk, did: a.did, network: 'regtest', fundingUtxos: [chain.satUtxo, chain.fund(50_000)], satSigner: walletSigner, changeAddress: WALLET_ADDRESS, feeRate: 2, provider: chain.provider, clock: headerClock(), index: INDEX, recoveryStore: null });
const zip = (await a.sdk.package(a.did)).bytes;
await landing.anchoring.submit('alice', { did: a.did, evidence: zip, pair });
chain.mine();
const secret = 'library-browser-fixture-secret-32-chars';
const originals = createOriginalsRoutes({ jwtSecret: secret, store: createOriginalsStore({ dataDir: landing.dataDir }), library: createAnchoringLibrary(landing.dataDir) });
const server = Bun.serve({ hostname: '127.0.0.1', port: 3102, async fetch(req) {
  const url = new URL(req.url);
  const account = /(?:^|;\s*)fixture_account=(alice|bob)/.exec(req.headers.get('cookie') ?? '')?.[1];
  if (url.pathname === '/api/__fixture/account') {
    const name = url.searchParams.get('name');
    if (name !== 'alice' && name !== 'bob' && name !== 'guest') return new Response('', { status: 400 });
    return Response.json({ account: name }, { headers: { 'Set-Cookie': `fixture_account=${name}; Path=/; SameSite=Lax; HttpOnly` } });
  }
  if (url.pathname === '/api/me') return account ? Response.json({ subOrgId: account, email: `${account}@example.invalid` }) : Response.json({}, { status: 401 });
  if (url.pathname === '/api/auth/logout') return Response.json({}, { headers: { 'Set-Cookie': 'fixture_account=guest; Path=/; SameSite=Lax; HttpOnly' } });
  if (url.pathname === '/api/__fixture/pair' && account === 'alice') return Response.json({ did: a.did, evidence: base64.encode(zip), pair, savedAt: new Date().toISOString() });
  if (url.pathname === '/api/__fixture/historical-evidence' && account === 'alice') return new Response(Bun.file(new URL('../../../docs/regtest/receipts/originals-live-turnkey-975-2026-10-24.zip', import.meta.url)));
  if (url.pathname === '/api/__fixture/counts') return Response.json({ broadcasts: chain.sent.length });
  const headers = new Headers(req.headers);
  if (account) headers.set('Authorization', `Bearer ${signToken(account, `${account}@example.invalid`, undefined, { secret })}`);
  const authed = new Request(req, { headers });
  if (url.pathname === '/api/originals') return originals.list(authed, url);
  if (url.pathname === '/api/originals/evidence') return originals.evidence(authed, url);
  if (url.pathname === '/api/btc/network') return Response.json({ network: 'off' });
  if (url.pathname.startsWith('/api/btc/') && account === 'alice') return landing.fetchImpl(url.pathname + url.search, { method: req.method, body: req.method === 'POST' ? await req.text() : undefined, headers: { 'content-type': 'application/json' } });
  return Response.json({ error: 'fixture_not_found' }, { status: 404 });
} });
console.log(JSON.stringify({ fixture: 'local keys, simulated Bitcoin, no Turnkey', port: server.port, did: a.did }));
