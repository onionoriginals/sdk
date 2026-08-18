/**
 * Production server for the landing app (Railway) — single service.
 *
 * Serves the built SPA (`apps/landing/dist`) on `$PORT`, hosts the real
 * did:webvh logs at `/api/host/*` + the resolver URLs (Track A — no secrets
 * needed), and — when the Turnkey auth env is present — ALSO mounts the `/api`
 * auth routes (and, when a testnet4 faucet is configured, `/api/btc/*` for real
 * inscription) in the SAME process, so everything is same-origin. Without the
 * auth env, `/api/*` (except the host store) returns a clear JSON 404.
 *
 * Enable the auth API by setting: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY,
 * TURNKEY_ORGANIZATION_ID, JWT_SECRET. Enable real testnet4 inscription by ALSO
 * setting QUICKNODE_ENDPOINT + BTC_FAUCET_WALLET_ID + BTC_FAUCET_ADDRESS.
 */
import { createInMemorySessionStorage } from '@originals/auth/server';
import { QuickNodeProvider } from '@originals/sdk';
import { buildFetch } from './server/app';
import { createWebvhHostStore } from './server/webvh-host';
import { buildRoutes } from './server/index';
import { getTurnkey } from './server/turnkey';
import {
  createBitcoinRoutes,
  isBitcoinConfigured,
  serverBtcNetwork,
  rawKeyFaucetSigner,
  turnkeyFaucetSigner,
  fetchFaucetUtxos,
  type FaucetProvider,
  type FaucetTxSigner,
} from './server/bitcoin';
import type { Handler } from './server/router';
import { createOriginalsStore } from './server/originals-store';
import { createInscriptionsStore } from './server/inscriptions-store';
import { createOriginalsRoutes, type OriginalsRoutes } from './server/originals-routes';
import { isLikelyDeployed } from './server/deploy-env';

const DIST = new URL('./dist/', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3000);
const hostStore = createWebvhHostStore();
// Durable Originals persist here. Without an explicit ORIGINALS_DATA_DIR the
// store falls back to a path INSIDE the container/cwd — fine for dev, but on a
// deploy that dir is ephemeral and every redeploy silently wipes signed-in
// users' Originals. buildBanner() below warns loudly when that's the case.
const originalsDataDir = process.env.ORIGINALS_DATA_DIR ?? './.originals-data';
const originalsDataDirIsExplicit = !!process.env.ORIGINALS_DATA_DIR;
const originalsStore = createOriginalsStore({ dataDir: originalsDataDir });
// In-flight commit+reveal pairs persist next to the Originals (same data dir,
// same JWT-sub namespacing) so a dead tab can never strand committed funds.
const inscriptionsStore = createInscriptionsStore({ dataDir: originalsDataDir });

// The server-side Bitcoin network (BTC_NETWORK=mainnet|testnet4, default
// testnet4). The QuickNodeProvider verifies getblockchaininfo.chain against
// this on first RPC (the CHAIN_TO_NETWORK guard from issue #350) and fails
// loudly on a mismatch — the seatbelt against a wrong-network endpoint.
const btcNet = serverBtcNetwork();
const providerNetwork = btcNet === 'mainnet' ? 'mainnet' : 'testnet';
// mempool.space REST base: free address/UTXO reads on both networks.
const mempoolApi =
  process.env.MEMPOOL_API ??
  (btcNet === 'mainnet'
    ? 'https://mempool.space/api'
    : process.env.MEMPOOL_TESTNET4_API ?? 'https://mempool.space/testnet4/api');

// QuickNode gives the ordinals-aware sat lookup + fee + broadcast. The faucet's
// own confirmed UTXOs come from mempool.space's testnet4 address API (free, no
// add-on needed) — see fetchFaucetUtxos in server/bitcoin.ts.
function createFaucetProviderFromEnv(): FaucetProvider {
  const provider = new QuickNodeProvider({
    endpoint: process.env.QUICKNODE_ENDPOINT!,
    expectedNetwork: providerNetwork,
  }) as unknown as FaucetProvider;
  // Network threaded through so the P2WPKH script derivation matches the
  // address prefix (bc1q on mainnet, tb1q on testnet4) — only the faucet
  // calls this today, but a mainnet caller must not hit the tb1q-only path.
  provider.getSpendableUtxos = (address: string) =>
    fetchFaucetUtxos({ api: mempoolApi, address, network: providerNetwork });
  return provider;
}

function buildApiRoutes(): { routes: Record<string, Handler>; originals: OriginalsRoutes } | null {
  const jwtSecret = process.env.JWT_SECRET;
  const configured =
    jwtSecret &&
    process.env.TURNKEY_API_PUBLIC_KEY &&
    process.env.TURNKEY_API_PRIVATE_KEY &&
    process.env.TURNKEY_ORGANIZATION_ID;
  if (!configured) return null;
  const turnkey = getTurnkey();
  let bitcoin;
  if (isBitcoinConfigured()) {
    if (btcNet === 'mainnet') {
      // Creator-pays mainnet: NO faucet — the creator deposits to their own
      // Turnkey-derived bc1q address and the inscription spends their UTXO.
      // The funding route is stripped entirely (not merely disabled).
      const routes = createBitcoinRoutes({
        jwtSecret,
        provider: createFaucetProviderFromEnv(),
        network: 'mainnet',
        depositApi: mempoolApi,
        inscriptions: inscriptionsStore,
      });
      bitcoin = { ...routes, funding: undefined };
      console.log('[landing] MAINNET inscription configured — /api/btc/* live (creator-pays, no faucet)');
    } else {
      // Pick the faucet signer: a raw testnet WIF (simplest) or a Turnkey-org wallet.
      let faucetAddress = process.env.BTC_FAUCET_ADDRESS!;
      let signFundingTx: FaucetTxSigner;
      if (process.env.BTC_FAUCET_WIF) {
        const signer = rawKeyFaucetSigner(process.env.BTC_FAUCET_WIF);
        signFundingTx = signer.signFundingTx;
        if (signer.address !== faucetAddress) {
          console.warn(
            `[landing] BTC_FAUCET_ADDRESS (${faucetAddress}) != the WIF's address (${signer.address}) — using the WIF's.`
          );
          faucetAddress = signer.address;
        }
        console.log('[landing] testnet4 inscription configured — /api/btc/* live (raw-key faucet)');
      } else {
        signFundingTx = turnkeyFaucetSigner(turnkey, faucetAddress);
        console.log('[landing] testnet4 inscription configured — /api/btc/* live (Turnkey-org faucet)');
      }
      bitcoin = createBitcoinRoutes({
        jwtSecret,
        provider: createFaucetProviderFromEnv(),
        faucet: { address: faucetAddress, signFundingTx },
        faucetSats: Number(process.env.BTC_FAUCET_SATS ?? 20_000),
        network: 'testnet',
        depositApi: mempoolApi,
        inscriptions: inscriptionsStore,
      });
    }
  } else {
    console.warn(
      `[landing] ${btcNet} inscription disabled (QUICKNODE_ENDPOINT${btcNet === 'mainnet' ? '' : '/BTC_FAUCET_*'} absent) — inscribe stays mock`
    );
  }
  const originals = createOriginalsRoutes({ jwtSecret, store: originalsStore });
  return {
    routes: buildRoutes({ turnkey, sessions: createInMemorySessionStorage(), jwtSecret, bitcoin, originals }),
    originals,
  };
}

const api = buildApiRoutes();

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: buildFetch({
    apiRoutes: api?.routes ?? null,
    hostStore,
    distDir: DIST,
    originals: api?.originals ?? null,
  }),
});

console.log(
  `[landing] serving ${DIST} on http://0.0.0.0:${server.port} (auth API: ${api ? 'enabled' : 'static-only'})`
);
console.log(
  `[landing] durable Originals dir: ${originalsDataDir}${originalsDataDirIsExplicit ? '' : ' (default — NOT set via ORIGINALS_DATA_DIR)'}`
);

// Monitoring sweep (stranger-safe checklist): pending inscriptions older than
// 24h mean a stranded commit — funds waiting on a reveal rebroadcast that
// nobody clicked. Warn hourly so they can't silently accumulate; the fix is
// the per-user "Finish inscription" flow (or POST /api/btc/inscribe/rebroadcast).
if (api) {
  const sweep = () => {
    try {
      const stale = inscriptionsStore.sweepStale(24 * 60 * 60_000);
      if (stale.length > 0) {
        console.warn(
          `[landing] ${stale.length} pending inscription(s) older than 24h — stranded commits awaiting reveal rebroadcast:\n` +
            stale.map((s) => `  sub=${s.subOrgId} commit=${s.commitTxId} status=${s.status} createdAt=${s.createdAt}`).join('\n')
        );
      }
    } catch (err) {
      console.warn('[landing] stale-inscription sweep failed', err);
    }
  };
  sweep();
  setInterval(sweep, 60 * 60_000);
}

// Loud guard against the silent data-loss trap: durable Originals only matter
// when the auth API is enabled (signed-in users), and only persist across
// redeploys if ORIGINALS_DATA_DIR points at a mounted volume. Warn — don't
// throw: the anonymous demo + Track-A hosting must still run without it.
if (api && !originalsDataDirIsExplicit && isLikelyDeployed()) {
  console.warn(
    '\n' +
      '  ┌──────────────────────────────────────────────────────────────────────┐\n' +
      '  │  !  ORIGINALS_DATA_DIR is not set on a deployed instance.              │\n' +
      "  │     Signed-in users' Originals are being written to an EPHEMERAL       │\n" +
      '  │     container path and will be LOST on the next redeploy.              │\n' +
      '  │     Fix: attach a persistent volume and set ORIGINALS_DATA_DIR to      │\n' +
      '  │     its mount path (e.g. ORIGINALS_DATA_DIR=/data).                    │\n' +
      '  └──────────────────────────────────────────────────────────────────────┘\n'
  );
}
