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
  quickNodeOrdinalLookup,
  cachedOrdinalLookup,
  createDepositBalanceSweep,
  positiveInt,
  type FaucetProvider,
  type FaucetTxSigner,
  type OrdinalLookup,
} from './server/bitcoin';
import { createMoneyLogger } from './server/money-log';
import type { Handler } from './server/router';
import { createOriginalsStore } from './server/originals-store';
import { createInscriptionsStore } from './server/inscriptions-store';
import { createOriginalsRoutes, type OriginalsRoutes } from './server/originals-routes';
import {
  createInscriptionCompletionSweep,
  type SweepProvider,
} from './server/inscription-completion-sweep';
import { checkConfig, isStrictConfig, resolveDataDir, isBareHost } from './server/config';

// The configuration contract (R10/R23), FIRST: a deployed instance missing or
// malforming a required value says so by name here, before a single request is
// served. Warn-only until CONFIG_STRICT=1 — see server/config.ts for why.
const configIssues = checkConfig();

const DIST = new URL('./dist/', import.meta.url).pathname;
// Guarded parse, not `Number(x ?? default)`: NaN is not nullish, so a
// malformed value would sail past the default and silently break the thing it
// configures. checkConfig() above names any such value at boot.
const port = positiveInt(process.env.PORT, 3000);
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
// Every money-path transition lands here (R29). Identity is the Turnkey
// sub-org id only — these lines link an account to on-chain activity and go to
// a third-party log sink.
const money = createMoneyLogger();
// Per-candidate ordinal classification via the Ordinals & Runes add-on
// (`ord_getOutput`), memoized per outpoint so the 15s deposit poll does not
// pay a call per UTXO per tick. ABSENT without a QuickNode endpoint, which
// makes the deposit route offer NOTHING as spendable — fail closed, because a
// 546-sat ordinal pulled in as a top-up is an inscription burned as fees.
const ordinals: OrdinalLookup | undefined = process.env.QUICKNODE_ENDPOINT
  ? cachedOrdinalLookup(quickNodeOrdinalLookup({ endpoint: process.env.QUICKNODE_ENDPOINT }))
  : undefined;

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
        ordinals,
        moneyLog: money,
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
        faucetSats: positiveInt(process.env.BTC_FAUCET_SATS, 20_000),
        network: 'testnet',
        indexer,
        ordinals,
        moneyLog: money,
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

/**
 * The canonical host for did:webvh (#529). Bare hostname only — the DID embeds
 * it verbatim, so a scheme or path here would mint identifiers that cannot
 * resolve. Unset (dev, tests) means no redirect and no pinning.
 */
function canonicalWebvhHost(): string | undefined {
  const v = process.env.VITE_WEBVH_HOST?.trim();
  return v && isBareHost(v) ? v : undefined;
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
    // The one host did:webvh identifiers may name (#529). Same value the SPA
    // bakes in, read at runtime here so the redirect and the DID agree; a bad
    // value is already a named violation in the boot config report.
    canonicalHost: canonicalWebvhHost(),
  }),
  // Last line of defence (R3): a handler that throws must not reach a client
  // as an untyped 500 with nothing in the log. One named JSON body, one
  // grep-able line — the operator has a single instrument, so anything that
  // escapes a handler has to land in it.
  error(err) {
    console.error('[landing] unhandled request error', err);
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  },
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
  // Rides the SAME hourly timer as the stale-inscription sweep — a second
  // timer would be a second, undeclared draw on the indexer budget. Read
  // budget (see createDepositBalanceSweep): hourly, at most 50 addresses per
  // pass from a rotating cursor, and an address drops out once it has nothing
  // in flight, last read zero, and has been quiet for 24h.
  const depositSweep = createDepositBalanceSweep({
    store: inscriptionsStore,
    indexer,
    network: providerNetwork,
    moneyLog: money,
    maxPerPass: positiveInt(process.env.DEPOSIT_SWEEP_MAX_PER_PASS, 50),
  });
  // Finish what can be finished (#545), BEFORE reporting what is stuck: a
  // record this pass completes should not also be warned about as stranded.
  // Its own provider instance: the routes build theirs inside buildApiRoutes
  // and never expose it, and a sweep that only reads status and broadcasts
  // needs nothing the routes' instance holds. Same endpoint, same network.
  const completionSweep = createInscriptionCompletionSweep({
    store: inscriptionsStore,
    provider: createFaucetProviderFromEnv() as unknown as SweepProvider,
    moneyLog: money,
    maxPerPass: positiveInt(process.env.INSCRIBE_SWEEP_MAX_PER_PASS, 25),
  });
  const sweep = () => {
    void completionSweep()
      .then((r) => {
        if (r.completed > 0 || r.failed > 0) {
          console.warn(
            `[landing] inscription completion sweep: ${r.completed} reveal(s) broadcast, ` +
              `${r.failed} failed, ${r.waiting} awaiting commit confirmation`
          );
        }
      })
      .catch((err) => console.warn('[landing] inscription completion sweep failed', err));
    try {
      const { stale, unreadable } = inscriptionsStore.sweepStale(24 * 60 * 60_000);
      if (stale.length > 0) {
        console.warn(
          `[landing] ${stale.length} inscription(s) older than 24h still holding un-landed recovery artifacts:\n` +
            stale.map((s) => `  sub=${s.subOrgId} commit=${s.commitTxId} status=${s.status} createdAt=${s.createdAt}`).join('\n')
        );
      }
      // LOUDER than a stale record, not quieter: that file holds the only copy
      // of a signed reveal, and the sweep can no longer see this user at all.
      if (unreadable.length > 0) {
        console.warn(
          `[landing] ${unreadable.length} inscription file(s) could NOT be parsed — those users are invisible to this sweep and their signed reveals may be unrecoverable:\n` +
            unreadable.map((sub) => `  sub=${sub}`).join('\n')
        );
      }
    } catch (err) {
      console.warn('[landing] stale-inscription sweep failed', err);
    }
    // The only instrument that sees a stranger's funds sitting unspent at a
    // deposit address nobody is polling.
    void depositSweep().catch((err) => console.warn('[landing] deposit balance sweep failed', err));
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
