/**
 * The landing server's request handler, in process, over the simulated chain:
 * the same buildRoutes/buildFetch serve.ts mounts, with the anchoring routes
 * on. Requests carry a session cookie for one account, as a signed-in browser's
 * do. Turnkey is never called on these paths.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Turnkey } from '@turnkey/sdk-server';
import { createInMemorySessionStorage, getAuthCookieConfig, signToken } from '@originals/auth/server';
import { buildFetch } from '../app';
import { buildRoutes } from '../index';
import { createBitcoinRoutes } from '../bitcoin';
import { serializeCookie } from '../cookies';
import { createInscriptionsStore } from '../inscriptions-store';
import { createMoneyLogger } from '../money-log';
import { createOriginalsAnchoring } from '../originals-anchoring';
import { createWebvhHostStore } from '../webvh-host';
import { INDEX, NETWORK, WALLET_ADDRESS, blockHeader, type fakeChain, headerClock } from './originals-chain-fixture';

const JWT = 'test-secret-at-least-32-chars-long!!';

export function inProcessLanding(chain: ReturnType<typeof fakeChain>, sub = 'sub-engine') {
  const dataDir = mkdtempSync(join(tmpdir(), 'landing-'));
  const inscriptions = createInscriptionsStore({ dataDir });
  inscriptions.bindDepositAddress(sub, NETWORK, WALLET_ADDRESS);
  const money: string[] = [];
  const moneyLog = createMoneyLogger((l) => money.push(l));
  const anchoring = createOriginalsAnchoring({ dataDir, provider: chain.provider, clock: headerClock(), index: INDEX, money: moneyLog });
  const bitcoin = createBitcoinRoutes({
    jwtSecret: JWT, provider: chain.provider, inscriptions, network: NETWORK, indexer: { api: 'https://fake-indexer.test' },
    fetchImpl: chain.indexerFetch, ordinals: chain.ordinals, moneyLog, anchoring,
    headers: async (height) => blockHeader(height),
  });
  const apiRoutes = buildRoutes({ turnkey: {} as Turnkey, sessions: createInMemorySessionStorage(), jwtSecret: JWT, bitcoin: { ...bitcoin, funding: undefined } });
  const handler = buildFetch({ apiRoutes, hostStore: createWebvhHostStore(), distDir: dataDir, trustedProxyHops: 0, log: () => undefined });
  const cookie = serializeCookie(getAuthCookieConfig(signToken(sub, 'a@b.com', undefined, { secret: JWT })));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://landing.test');
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    return handler(new Request(url, { ...init, headers }));
  }) as typeof fetch;
  return { fetchImpl, dataDir, anchoring, money };
}
