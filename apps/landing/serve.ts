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
  resolveIndexer,
  type FaucetProvider,
  type FaucetTxSigner,
} from './server/bitcoin';
import type { Handler } from './server/router';
import { createOriginalsStore } from './server/originals-store';
import { createInscriptionsStore } from './server/inscriptions-store';
import { createOriginalsRoutes, type OriginalsRoutes } from './server/originals-routes';
import { checkConfig, isStrictConfig, resolveDataDir } from './server/config';

// The configuration contract (R10/R23), FIRST: a deployed instance missing or
// malforming a required value says so by name here, before a single request is
// served. Warn-only until CONFIG_STRICT=1 — see server/config.ts for why.
const configIssues = checkConfig();

const DIST = new URL('./dist/', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3000);
const hostStore = createWebvhHostStore();
// Durable Originals persist here. Without an explicit ORIGINALS_DATA_DIR the
// store falls back to a path INSIDE the container/cwd — fine for dev, but on a
// deploy that dir is ephemeral and every redeploy silently wipes signed-in
// users' Originals (checkConfig() above reports exactly that, by name).
const { path: originalsDataDir, explicit: originalsDataDirIsExplicit } = resolveDataDir(process.env);
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
// The deposit indexer seam (KTD4): ONE configurable, optionally authenticated
// Esplora-shaped base URL behind every address->UTXO read in this process —
// the creator-pays deposit route AND the testnet4 faucet alike. Defaults to
// the free public API per network; BTC_INDEXER_API/BTC_INDEXER_TOKEN move it
// to a paid tier or a private index without a code change.
const indexer = resolveIndexer(process.env, providerNetwork);

// QuickNode gives the ordinals-aware sat lookup + fee + broadcast. Address
// reads are NOT QuickNode: its Ordinals add-on has no address surface and Core
// there has no address index — see resolveIndexer in server/bitcoin.ts.
function createFaucetProviderFromEnv(): FaucetProvider {
  const provider = new QuickNodeProvider({
    endpoint: process.env.QUICKNODE_ENDPOINT!,
    expectedNetwork: providerNetwork,
  }) as unknown as FaucetProvider;
  // Network threaded through so the P2WPKH script derivation matches the
  // address prefix (bc1q on mainnet, tb1q on testnet4) — only the faucet
  // calls this today, but a mainnet caller must not hit the tb1q-only path.
  provider.getSpendableUtxos = (address: string) =>
    fetchFaucetUtxos({ ...indexer, address, network: providerNetwork });
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
        indexer,
        inscriptions: inscriptionsStore,
      });
      bitcoin = { ...routes, funding: undefined };
      console.log('[landing] MAINNET inscription configured — /api/btc/* live (creator-pays, no faucet)');
      // Which index a stranger's deposit is actually read from, on one line.
      console.log(
        `[landing] deposit indexer: ${indexer.api}${indexer.authToken ? ' (authenticated)' : ' (no token — free public tier)'}`
      );
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
        indexer,
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

// Monitoring sweep (stranger-safe checklist): any inscription still holding
// un-broadcast recovery artifacts after 24h is stranded money — a commit that
// never went out, a reveal that never went out, or a reveal that went out and
// never confirmed. Warn hourly so they can't silently accumulate; the list
// poll auto-recovers most of them, and the per-user "Finish inscription" flow
// (POST /api/btc/inscribe/rebroadcast) is the manual shortcut.
if (api) {
  const sweep = () => {
    try {
      const stale = inscriptionsStore.sweepStale(24 * 60 * 60_000);
      if (stale.length > 0) {
        console.warn(
          `[landing] ${stale.length} inscription(s) older than 24h still holding un-landed recovery artifacts:\n` +
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

// One-line summary of the contract check that ran at the top of this file.
// The detail (every offending value, by name) is already in the log above.
console.log(
  `[landing] config contract: ${configIssues.length === 0 ? 'clean' : `${configIssues.length} issue(s)`}` +
    ` (strict=${isStrictConfig() ? 'on' : 'off'})`
);
