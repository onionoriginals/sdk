/**
 * Unified production server for the landing app (Railway entry).
 *
 * One origin serves: the built SPA (with SPA fallback + traversal guard), the
 * auth API (only when JWT_SECRET + TURNKEY_* are present; otherwise 503 stubs),
 * the WebVH host write endpoint (PUT /api/host/*), and the hosted did:webvh logs
 * at the exact URLs didwebvh-ts's resolver GETs. No secrets are required to run
 * the SPA and the real did:webvh hosting demo (Track A).
 */
import { createInMemorySessionStorage } from '@originals/auth/server';
import { QuickNodeProvider } from '@originals/sdk';
import { buildFetch } from './server/app';
import { createWebvhHostStore } from './server/webvh-host';
import { buildRoutes, buildStubRoutes } from './server/index';
import { getTurnkey } from './server/turnkey';
import { createBitcoinRoutes, isBitcoinConfigured, type FaucetProvider } from './server/bitcoin';

// QuickNodeProvider + a faucet UTXO lookup. getSpendableUtxos uses the Ordinals
// add-on's address index (ord_getAddressOutputs) or bitcoind scantxoutset. The
// exact RPC is a manual-smoke wiring point; the shape is fixed here.
function createFaucetProviderFromEnv(): FaucetProvider {
  const base = new QuickNodeProvider({
    endpoint: process.env.QUICKNODE_ENDPOINT!,
    expectedNetwork: 'testnet',
  });
  const provider = base as unknown as FaucetProvider;
  provider.getSpendableUtxos = async (address: string) => {
    // Explicit throw-until-wired (NOT a placeholder in shipping logic): the
    // faucet route fails loudly (faucet_unavailable, 502) until the deploy
    // provides the address-index call for its QuickNode add-on / bitcoind.
    throw new Error(
      `getSpendableUtxos not wired for ${address}: implement against the QuickNode Ordinals add-on address index or bitcoind scantxoutset before enabling the faucet.`
    );
  };
  return provider;
}

const distDir = new URL('./dist/', import.meta.url).pathname;
const hostStore = createWebvhHostStore();

const jwtSecret = process.env.JWT_SECRET;
const turnkeyConfigured =
  !!process.env.TURNKEY_API_PUBLIC_KEY &&
  !!process.env.TURNKEY_API_PRIVATE_KEY &&
  !!process.env.TURNKEY_ORGANIZATION_ID;

let routes;
if (jwtSecret && turnkeyConfigured) {
  const turnkey = getTurnkey();
  let bitcoin: import('./server/bitcoin').BitcoinRoutes | undefined;
  if (isBitcoinConfigured()) {
    // QuickNodeProvider gives sat/fee/broadcast; a thin subclass adds the
    // faucet's spendable-UTXO lookup. No raw key — the faucet is a Turnkey wallet.
    const provider = createFaucetProviderFromEnv();
    bitcoin = createBitcoinRoutes({
      turnkey,
      jwtSecret,
      provider,
      faucet: { walletId: process.env.BTC_FAUCET_WALLET_ID!, address: process.env.BTC_FAUCET_ADDRESS! },
      faucetSats: Number(process.env.BTC_FAUCET_SATS ?? 20_000),
    });
    console.log('[landing] testnet4 inscription configured — /api/btc/* live');
  } else {
    console.warn('[landing] testnet4 inscription disabled (QUICKNODE_ENDPOINT/BTC_FAUCET_* absent) — inscribe stays mock');
  }
  routes = buildRoutes({
    turnkey,
    sessions: createInMemorySessionStorage(),
    jwtSecret,
    bitcoin,
  });
  console.log('[landing] auth configured — /api/auth/* live');
} else {
  console.warn(
    '[landing] auth unconfigured (JWT_SECRET/TURNKEY_* absent) — /api/auth/* returns 503; SPA + did:webvh hosting still work'
  );
  routes = buildStubRoutes();
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  hostname: '0.0.0.0',
  fetch: buildFetch({ routes, hostStore, distDir }),
});

console.log(`[landing] unified server on http://0.0.0.0:${server.port}`);
