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
  rawKeyFaucetSigner,
  turnkeyFaucetSigner,
  fetchFaucetUtxos,
  type FaucetProvider,
  type FaucetTxSigner,
} from './server/bitcoin';
import type { Handler } from './server/router';

const DIST = new URL('./dist/', import.meta.url).pathname;
const port = Number(process.env.PORT ?? 3000);
const hostStore = createWebvhHostStore();

// QuickNode gives the ordinals-aware sat lookup + fee + broadcast. The faucet's
// own confirmed UTXOs come from mempool.space's testnet4 address API (free, no
// add-on needed) — see fetchFaucetUtxos in server/bitcoin.ts.
function createFaucetProviderFromEnv(faucetAddress: string): FaucetProvider {
  const provider = new QuickNodeProvider({
    endpoint: process.env.QUICKNODE_ENDPOINT!,
    expectedNetwork: 'testnet',
  }) as unknown as FaucetProvider;
  const api = process.env.MEMPOOL_TESTNET4_API ?? 'https://mempool.space/testnet4/api';
  provider.getSpendableUtxos = (address: string) => fetchFaucetUtxos({ api, address });
  return provider;
}

function buildApiRoutes(): Record<string, Handler> | null {
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
      provider: createFaucetProviderFromEnv(faucetAddress),
      faucet: { address: faucetAddress, signFundingTx },
      faucetSats: Number(process.env.BTC_FAUCET_SATS ?? 20_000),
    });
  } else {
    console.warn('[landing] testnet4 inscription disabled (QUICKNODE_ENDPOINT/BTC_FAUCET_* absent) — inscribe stays mock');
  }
  return buildRoutes({ turnkey, sessions: createInMemorySessionStorage(), jwtSecret, bitcoin });
}

const apiRoutes = buildApiRoutes();

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: buildFetch({ apiRoutes, hostStore, distDir: DIST }),
});

console.log(
  `[landing] serving ${DIST} on http://0.0.0.0:${server.port} (auth API: ${apiRoutes ? 'enabled' : 'static-only'})`
);
