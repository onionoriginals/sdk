/**
 * Server Bitcoin routes: a testnet4 faucet + thin QuickNode proxies.
 *
 * The faucet funds a logged-in user's testnet4 address so the user's own
 * Turnkey key can sign the inscription in the browser. The faucet can sign its
 * funding tx two ways (rawKeyFaucetSigner / turnkeyFaucetSigner) — coins are
 * worthless tBTC, so a raw key is fine for a demo. Every route is auth-gated
 * (JWT cookie) + rate-limited; the faucet signs ONLY its own funding tx to a
 * logged-in user's testnet address, never a general signing oracle.
 */
import * as btc from '@scure/btc-signer';
import { hex, base64, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { Turnkey } from '@turnkey/sdk-server';
import { verifyToken } from '@originals/auth/server';
import type { OrdinalsProvider } from '@originals/sdk';
import { isValidBitcoinAddress } from '@originals/sdk';
import { json, type Handler } from './router';
import { extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';
import { outpointsOf } from './inscriptions-store';
import type { InscriptionsStore, InscriptionRecord } from './inscriptions-store';

/**
 * The server-side network flag: BTC_NETWORK=mainnet|testnet4 (default testnet4).
 * Env is a parameter so the boot-time config contract can judge a snapshot.
 */
export function serverBtcNetwork(
  env: Record<string, string | undefined> = process.env
): 'mainnet' | 'testnet4' {
  return env.BTC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet4';
}

export function isBitcoinConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!env.QUICKNODE_ENDPOINT) return false;
  // Mainnet is creator-pays: no faucet env needed (and none is mounted).
  if (serverBtcNetwork(env) === 'mainnet') return true;
  return (
    !!env.BTC_FAUCET_ADDRESS &&
    (!!env.BTC_FAUCET_WIF || !!env.BTC_FAUCET_WALLET_ID)
  );
}

// Provider surface these routes use (a superset of OrdinalsProvider — the
// faucet also needs the faucet wallet's spendable UTXOs). Production wires a
// QuickNodeProvider whose getSpendableUtxos lists the faucet address's UTXOs.
export interface FaucetProvider extends OrdinalsProvider {
  getSpendableUtxos(address: string): Promise<
    Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>
  >;
}

export type BtcNet = 'mainnet' | 'testnet';

/** The scriptPubKey (hex) for a bech32 P2WPKH address (`tb1q…` or `bc1q…`). */
export function p2wpkhScriptHex(address: string, network: BtcNet = 'testnet'): string {
  const decoded = btc.Address(network === 'mainnet' ? btc.NETWORK : btc.TEST_NETWORK).decode(address);
  if (!decoded || decoded.type !== 'wpkh') {
    throw new Error(`Address must be P2WPKH (${network === 'mainnet' ? 'bc1q' : 'tb1q'}…): ${address}`);
  }
  // Cast: the narrowed wpkh shape is a valid OutScript input; the union type on
  // encode() otherwise widens to include undefined and fails to match.
  return hex.encode(btc.OutScript.encode(decoded as Parameters<typeof btc.OutScript.encode>[0]));
}

/**
 * An address's UTXOs from mempool.space's address API — free, no QuickNode
 * add-on needed, mainnet and testnet4 alike. Every UTXO pays to the address,
 * so its scriptPubKey is derived from it. Confirmed and unconfirmed are
 * returned separately: only confirmed ones are ever spent, but the deposit UI
 * shows "deposit detected" from the unconfirmed sum.
 */
export async function fetchAddressUtxos(opts: {
  api: string;
  address: string;
  network?: BtcNet;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{
  confirmed: Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>;
  unconfirmedSats: number;
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const scriptPubKey = p2wpkhScriptHex(opts.address, opts.network ?? 'testnet');
  // Bound the call so a hung mempool.space response can't hold the handler
  // (and the user's rate-limit slot) open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetchImpl(`${opts.api}/address/${opts.address}/utxo`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`mempool.space UTXO fetch failed (${res.status}) for ${opts.address}`);
  const utxos = (await res.json()) as Array<{
    txid: string;
    vout: number;
    value: number;
    status?: { confirmed?: boolean };
  }>;
  return {
    confirmed: utxos
      .filter((u) => u.status?.confirmed)
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubKey })),
    unconfirmedSats: utxos.filter((u) => !u.status?.confirmed).reduce((n, u) => n + u.value, 0),
  };
}

/**
 * The faucet's spendable UTXOs — CONFIRMED only (never spend our own
 * unconfirmed change). Kept as the faucet-facing wrapper over fetchAddressUtxos.
 */
export async function fetchFaucetUtxos(opts: {
  api: string;
  address: string;
  network?: BtcNet;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>> {
  return (await fetchAddressUtxos(opts)).confirmed;
}

/** Signs a built funding tx and returns broadcast-ready raw tx hex. */
export type FaucetTxSigner = (tx: btc.Transaction) => Promise<string>;

// Hard ceiling on the POST /api/btc/inscribe body: the signed commit + reveal
// hex pair. The reveal embeds the inscription envelope, so this doubles as the
// v1 inscription-content size cap (~100 KB of hex ≈ 50 KB of content) — huge
// inscriptions burn the creator's fee and our QuickNode bandwidth.
const MAX_INSCRIBE_BODY_BYTES = 100 * 1024;

/**
 * The exact rejections Bitcoin Core raises when the transaction is ALREADY on
 * the network. Matched as a closed set rather than a bare /already/: a
 * transport or provider error that merely CONTAINS the word ("connection
 * already closed") would otherwise count as a successful broadcast, and a
 * falsely-advanced record can park real funds — a reveal marked broadcast
 * that never went out is only rescued by the much slower staleness sweep.
 */
const ALREADY_KNOWN_TX_ERRORS = [
  'txn-already-in-mempool',
  'txn-already-known',
  'transaction already in block chain', // RPC -27
  'transaction already in mempool',
];

/**
 * True when a broadcast rejection means the transaction is ALREADY on the
 * network — success for our idempotent retry purposes. A conflicting-spend
 * rejection ("txn-mempool-conflict") is NOT a match.
 */
export function isAlreadyKnownTxError(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? '').toLowerCase();
  return ALREADY_KNOWN_TX_ERRORS.some((known) => msg.includes(known));
}

/**
 * Read at most maxBytes of the request body; null when it exceeds the cap.
 * Streams the body so a chunked request WITHOUT Content-Length is cut off at
 * the cap instead of being buffered whole (req.text() would buffer first and
 * check after — the cap must hold for dishonest clients too).
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export function createBitcoinRoutes(deps: {
  jwtSecret: string;
  provider: OrdinalsProvider | FaucetProvider;
  // `signFundingTx` decouples the routes from HOW the faucet is signed (raw key
  // or Turnkey org wallet — see rawKeyFaucetSigner / turnkeyFaucetSigner).
  // ABSENT on mainnet (creator-pays): the funding route then 404s.
  faucet?: { address: string; signFundingTx: FaucetTxSigner };
  faucetSats?: number;
  // Durable store for in-flight commit+reveal pairs (the stranded-funds fix).
  // The inscribe/rebroadcast routes 503 without it — they must never broadcast
  // a commit whose reveal is not persisted first.
  inscriptions?: InscriptionsStore;
  // Which Bitcoin network these routes serve; drives address validation and
  // which mempool.space API the deposit route reads.
  network?: BtcNet;
  // mempool.space REST base for the deposit route (e.g. https://mempool.space/api).
  depositApi?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): {
  funding: Handler;
  sat: Handler;
  fee: Handler;
  broadcast: Handler;
  deposit: Handler;
  networkInfo: Handler;
  inscribe: Handler;
  inscribeList: Handler;
  inscribeRebroadcast: Handler;
} {
  const faucetSats = deps.faucetSats ?? 20_000;
  const now = deps.now ?? (() => Date.now());
  // Per-client burst cap. Sized against the real traffic shape, not a round
  // number: the deposit screen polls every 15s (4/min) for as long as a creator
  // is funding, and a NAT/office egress address is ONE client identity — at
  // 30/min about seven concurrent creators would throttle each other off the
  // money path. The cost bounds are the auth gate and the per-user quota cap
  // below, so this only has to stop a single-address flood.
  const ipLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
  const userLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 }); // 5 fundings / user / hour
  // Real-spend + QuickNode-quota routes get their own per-user caps: the cost
  // vector on mainnet is the user's BTC and our API quota, not the faucet.
  const inscribeUserLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
  // Shared per-user cap for the proxy reads/broadcasts that burn QuickNode
  // quota (sat lookup, fee estimate, raw broadcast, deposit polls).
  const quotaUserLimiter = createRateLimiter({ limit: 120, windowMs: 60 * 60_000 });
  const provider = deps.provider as FaucetProvider;

  // How long an unconfirmed reveal may sit before the list poll re-pushes it.
  // Long enough that a reveal simply waiting for a block is not re-broadcast
  // on every poll; short enough that an evicted one is back in the mempool
  // within the hour.
  const REVEAL_REBROADCAST_AFTER_MS = 30 * 60_000;

  // ONE fee source for the money path (R3/KTD3). The deposit quote, the
  // /api/btc/fee estimate the browser builds the inscription against, and the
  // faucet's funding tx all read THIS. It fails closed: a floored 1 sat/vB
  // would quote a deposit the SDK's FEE_RATE_REQUIRED path then refuses to
  // spend at, stranding a stranger's real BTC mid-flow.
  //
  // Cached 60s per confirmation target so the UI's 15s deposit poll costs
  // QuickNode quota once a minute, not once a tick, with an in-flight promise
  // per target so a cold cache under concurrent polls refreshes ONCE.
  const FEE_CACHE_MS = 60_000;
  // Mirrors the SDK's MAX_REASONABLE_FEE_RATE (bitcoin/BitcoinManager.ts): a
  // compromised estimator must not be able to quote an arbitrary number at a
  // creator. Kept local — the SDK does not export it.
  const MAX_FEE_RATE_SAT_VB = 10_000;
  const feeCache = new Map<number, { at: number; rate: number }>();
  const feeInFlight = new Map<number, Promise<number>>();

  /** Shared estimator. Throws (never floors) when the source is unusable. */
  async function currentFeeRate(blocks = 1): Promise<number> {
    const cached = feeCache.get(blocks);
    if (cached && now() - cached.at < FEE_CACHE_MS) return cached.rate;
    const pending = feeInFlight.get(blocks);
    if (pending) return pending;
    const run = (async () => {
      const estimated = await provider.estimateFee(blocks);
      if (typeof estimated !== 'number' || !Number.isFinite(estimated) || estimated <= 0) {
        throw new Error(`Fee estimator returned an unusable rate (${estimated}).`);
      }
      const rate = Math.ceil(estimated);
      if (rate > MAX_FEE_RATE_SAT_VB) {
        throw new Error(`Estimated fee rate ${rate} sat/vB exceeds the ${MAX_FEE_RATE_SAT_VB} sat/vB maximum.`);
      }
      feeCache.set(blocks, { at: now(), rate });
      return rate;
    })();
    feeInFlight.set(blocks, run);
    // Clear the slot AFTER it is set — an estimator that throws synchronously
    // (config validated before any promise) would otherwise leave its rejected
    // promise parked here and re-serve that failure to every later poll. The
    // identity check keeps a settled run from evicting a newer one.
    const clear = () => { if (feeInFlight.get(blocks) === run) feeInFlight.delete(blocks); };
    run.then(clear, clear);
    return run;
  }

  // Rotating scan-start cursors for the list poll's reconciliation passes.
  // Each processed item advances the cursor, so successive polls start
  // further along the (stably ordered) worklist — a backlog larger than the
  // per-poll lookup budget is still fully covered over a few polls instead of
  // the same head items consuming the budget forever. Cursors are PER USER:
  // a shared cursor advanced by every user's differently sized worklist can
  // hit a residue that lands the same subset for one user forever (e.g. user
  // A consumes 5, an interleaved user B consumes 2, A's list length is 7 —
  // A restarts at index 0 on every poll). In-process bookkeeping only, not
  // durable state: losing it on restart merely restarts the rotation.
  const reconcileCursors = new Map<string, { superseded: number; stuck: number; confirm: number }>();
  function cursorsFor(sub: string): { superseded: number; stuck: number; confirm: number } {
    let c = reconcileCursors.get(sub);
    if (!c) {
      if (reconcileCursors.size >= 10_000) reconcileCursors.clear(); // bound the map
      c = { superseded: 0, stuck: 0, confirm: 0 };
      reconcileCursors.set(sub, c);
    }
    return c;
  }
  function rotate<T>(arr: T[], cursor: number): T[] {
    if (arr.length === 0) return arr;
    const start = cursor % arr.length;
    return [...arr.slice(start), ...arr.slice(0, start)];
  }

  /** 429 when the per-user QuickNode-quota cap is hit, else null. */
  function quotaCapped(sub: string): Response | null {
    const q = quotaUserLimiter.check(sub);
    if (!q.allowed) {
      return json({ error: 'user_quota_cap' }, 429, {
        'Retry-After': String(Math.ceil(q.retryAfterMs / 1000)),
      });
    }
    return null;
  }

  /** Returns the authenticated subOrgId, or null (→ 401). */
  function authSub(req: Request): string | null {
    const token = extractToken(req);
    if (!token) return null;
    try {
      return verifyToken(token, { secret: deps.jwtSecret }).sub;
    } catch {
      return null;
    }
  }

  // Keys on the identity the server layer resolved (client-ip.ts), NEVER on a
  // header read here — that is what made this limit bypassable by rotating
  // X-Forwarded-For. The per-user cap keyed on the JWT `sub` still bounds abuse.
  function rateLimited(clientIp: string | undefined): Response | null {
    const rl = ipLimiter.check(clientIp ?? 'local');
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, {
        'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }
    return null;
  }

  const sat: Handler = async (req, _url, clientIp) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(clientIp) ?? quotaCapped(sub);
    if (limited) return limited;
    const { txid, vout } = (await req.json().catch(() => ({}))) as { txid?: string; vout?: number };
    if (typeof txid !== 'string' || typeof vout !== 'number') return json({ error: 'bad_request' }, 400);
    if (typeof provider.getFirstSatOfOutput !== 'function') return json({ error: 'sat_index_unsupported' }, 501);
    try {
      const satoshi = await provider.getFirstSatOfOutput({ txid, vout });
      return json({ satoshi });
    } catch (e) {
      return json({ error: 'sat_lookup_failed', message: (e as Error).message }, 502);
    }
  };

  const fee: Handler = async (req, _url, clientIp) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(clientIp) ?? quotaCapped(sub);
    if (limited) return limited;
    const { blocks } = (await req.json().catch(() => ({}))) as { blocks?: number };
    try {
      // Same estimator (and same cache) the deposit quote was sized from —
      // the rate the creator is told to fund and the rate the inscription is
      // built at cannot drift apart.
      const feeRate = await currentFeeRate(typeof blocks === 'number' ? blocks : 1);
      return json({ feeRate });
    } catch (e) {
      return json({ error: 'fee_estimate_unavailable', message: (e as Error).message }, 502);
    }
  };

  const broadcast: Handler = async (req, _url, clientIp) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(clientIp) ?? quotaCapped(sub);
    if (limited) return limited;
    const { txHex } = (await req.json().catch(() => ({}))) as { txHex?: string };
    if (typeof txHex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(txHex)) return json({ error: 'bad_tx_hex' }, 400);
    try {
      const txid = await provider.broadcastTransaction(txHex);
      return json({ txid });
    } catch (e) {
      return json({ error: 'broadcast_failed', message: (e as Error).message }, 502);
    }
  };

  const funding: Handler = async (req, _url, clientIp) => {
    // Creator-pays deploys (mainnet) have no faucet at all — the route is not
    // mounted there, and this guard keeps a miswired mount fail-closed.
    const faucet = deps.faucet;
    if (!faucet) return json({ error: 'faucet_unavailable' }, 404);
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(clientIp);
    if (limited) return limited;

    // Validate the address BEFORE consuming a per-user faucet slot — otherwise
    // repeated bad-address requests would exhaust a user's hourly cap for free.
    const { address } = (await req.json().catch(() => ({}))) as { address?: string };
    if (!address || !isValidBitcoinAddress(address, 'testnet')) {
      return json({ error: 'bad_address', message: 'A testnet4 P2WPKH (tb1) address is required.' }, 400);
    }

    const perUser = userLimiter.check(sub);
    if (!perUser.allowed) {
      return json({ error: 'faucet_user_cap', message: 'Per-user faucet limit reached; try again later.' }, 429, {
        'Retry-After': String(Math.ceil(perUser.retryAfterMs / 1000)),
      });
    }

    // 1) Gather the faucet's spendable UTXOs; pick enough to cover fundingSats +
    //    a fixed fee floor. Empty faucet → 507.
    let faucetUtxos: Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>;
    try {
      faucetUtxos = await provider.getSpendableUtxos(faucet.address);
    } catch (e) {
      return json({ error: 'faucet_unavailable', message: (e as Error).message }, 502);
    }
    const totalAvail = faucetUtxos.reduce((n, u) => n + u.value, 0);
    if (faucetUtxos.length === 0 || totalAvail < faucetSats + 500) {
      return json({ error: 'faucet_empty', message: 'The testnet4 faucet is out of funds. Try again later.' }, 507);
    }

    // 2) Build the funding tx: faucet UTXOs in, fundingSats to the user, change
    //    back to the faucet. Fee = feeRate * estimated vsize (simple P2WPKH).
    let feeRate: number;
    try {
      feeRate = await currentFeeRate(1);
    } catch (e) {
      // No floor: a 1 sat/vB funding tx just sits unconfirmed, and the user
      // waits on a deposit that never arrives.
      return json({ error: 'fee_estimate_unavailable', message: (e as Error).message }, 502);
    }
    const selected: typeof faucetUtxos = [];
    let inSats = 0;
    for (const u of faucetUtxos) {
      selected.push(u);
      inSats += u.value;
      if (inSats >= faucetSats + 200) break;
    }
    // vsize ~ 10.5 + 68*inputs + 31*2 outputs (P2WPKH), rounded up.
    const vsize = Math.ceil(10.5 + 68 * selected.length + 31 * 2);
    const fee = feeRate * vsize;
    const change = inSats - faucetSats - fee;
    if (change < 0) return json({ error: 'faucet_empty', message: 'Faucet UTXOs too small for the fee.' }, 507);

    const tx = new btc.Transaction();
    for (const u of selected) {
      tx.addInput({
        txid: hex.decode(u.txid),
        index: u.vout,
        // BIP-125 opt-in RBF: a final-sequence funding tx would be un-bumpable
        // through a fee spike (mirrors the SDK's commit/reveal builders).
        sequence: 0xfffffffd,
        witnessUtxo: { script: hex.decode(u.scriptPubKey), amount: BigInt(u.value) },
      });
    }
    tx.addOutputAddress(address, BigInt(faucetSats), btc.TEST_NETWORK);
    if (change > 330) tx.addOutputAddress(faucet.address, BigInt(change), btc.TEST_NETWORK);

    // The funded outpoint is vout 0 (the user output). Capture its scriptPubKey
    // now — the SDK's createCommitTransaction REQUIRES it on the fundingUtxo to
    // set the segwit witnessUtxo (it throws "missing scriptPubKey" otherwise).
    const userScript = tx.getOutput(0).script;
    if (!userScript) return json({ error: 'funding_build_failed', message: 'No user output script.' }, 500);
    const scriptPubKey = hex.encode(userScript);

    // 3) Sign the funding tx with the faucet's key (raw WIF or Turnkey org) →
    //    broadcast-ready hex.
    let signedTxHex: string;
    try {
      signedTxHex = await faucet.signFundingTx(tx);
    } catch (e) {
      return json({ error: 'faucet_sign_failed', message: (e as Error).message }, 502);
    }

    // 4) Broadcast.
    let txid: string;
    try {
      txid = await provider.broadcastTransaction(signedTxHex);
    } catch (e) {
      return json({ error: 'faucet_broadcast_failed', message: (e as Error).message }, 502);
    }

    return json({
      fundingUtxo: { txid, vout: 0, value: faucetSats, scriptPubKey },
      changeAddress: address, // the user's own address is the inscription change/reveal dest
    });
  };

  /**
   * GET /api/btc/deposit?address=<the user's own P2WPKH address> — the
   * creator-pays core. Returns the address's confirmed UTXOs (spendable as
   * inscription funding), the unconfirmed sum (the "deposit detected" state),
   * and a buffered cost estimate so the UI can show a deposit target. UTXOs
   * come from mempool.space's free address API; the fee estimate from the
   * QuickNode provider. Nothing is custodied: the address is derived from the
   * user's own Turnkey key.
   */
  const deposit: Handler = async (req, url, clientIp) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(clientIp);
    if (limited) return limited;
    if (!deps.depositApi) return json({ error: 'deposit_unavailable' }, 503);
    const network = deps.network ?? 'testnet';

    const address = url.searchParams.get('address') ?? '';
    if (!address || !isValidBitcoinAddress(address, network)) {
      return json({ error: 'bad_address', message: `A ${network} P2WPKH address is required.` }, 400);
    }
    // One deposit address per user per network, bound on first use. The
    // funding address is deterministic (a Turnkey BIP-84 path), so this costs
    // an honest client nothing — and it stops the route being a general
    // UTXO-lookup proxy for any address a signed-in caller cares to name.
    if (deps.inscriptions) {
      const bound = deps.inscriptions.bindDepositAddress(sub, network, address);
      if (bound !== address) {
        return json({ error: 'address_not_bound', message: 'This account is bound to a different deposit address.' }, 403);
      }
    }
    // Optional content-size hint tightens the estimate; clamped to the same
    // ceiling the inscribe route enforces. The default is deliberately
    // GENEROUS: over-estimating only asks the creator to deposit more than
    // needed (the excess returns as change), while under-estimating strands
    // them mid-flow with a deposit that cannot fund the inscription.
    const contentBytesRaw = Number(url.searchParams.get('contentBytes'));
    const contentBytes = Number.isFinite(contentBytesRaw) && contentBytesRaw > 0
      ? Math.min(contentBytesRaw, MAX_INSCRIBE_BODY_BYTES / 2)
      : 8_000;

    // Resolve the fee BEFORE anything else, and fail closed (R3/KTD3): with no
    // rate there is no honest number to fund, so this route returns a named
    // error and NO address — the response carries nothing a UI could render as
    // "send this much here".
    let feeRate: number;
    try {
      feeRate = await currentFeeRate(1);
    } catch (e) {
      return json({ error: 'fee_estimate_unavailable', message: (e as Error).message }, 502);
    }

    let utxos: Awaited<ReturnType<typeof fetchAddressUtxos>>;
    try {
      utxos = await fetchAddressUtxos({ api: deps.depositApi, address, network, fetchImpl: deps.fetchImpl });
    } catch (e) {
      return json({ error: 'utxo_lookup_failed', message: (e as Error).message }, 502);
    }
    // Ordinal safety: the reveal sends the inscribed sat BACK to this same
    // address, so the user's inscription outputs sit among their funding
    // UTXOs. Spending one as the funding input would make an existing
    // inscription's sat the DID sat of a new one. Postage (546) is always
    // below estimatedCostSats so the UI would not pick one today — but that
    // is arithmetic, not a rule, so exclude them explicitly.
    const inscriptionOutpoints = new Set(
      deps.inscriptions?.list(sub).map((r) => `${r.revealTxId}:0`) ?? []
    );
    const confirmedUtxos = utxos.confirmed.filter(
      (u) => !inscriptionOutpoints.has(`${u.txid}:${u.vout}`)
    );
    // Commit ≈ 85 vB of fixed shape (overhead + P2TR commit output + P2WPKH
    // change) plus 68 vB PER P2WPKH input, and reveal ≈ 111 vB + the
    // witness-discounted envelope (content + ~300 bytes of tags/script
    // overhead) — the same shape commit.ts estimates precisely once the
    // content exists. 1.5× buffer absorbs a fee move between the deposit and
    // the broadcast; postage rides on top.
    const COMMIT_BASE_VB = 85;
    const COMMIT_INPUT_VB = 68;
    const revealVB = 111 + Math.ceil((contentBytes + 300) / 4);
    const costFor = (inputs: number) =>
      Math.ceil(feeRate * (COMMIT_BASE_VB + COMMIT_INPUT_VB * inputs + revealVB) * 1.5) + 546;
    // The quote must price the inputs the creator will ACTUALLY spend (R26): a
    // flat one-input figure under-quotes the moment a second UTXO is needed,
    // which lands them back in the shortfall this route exists to prevent.
    // Walk the same largest-first order the client selects in, re-checking the
    // (rising) target as each input is added.
    let inputCount = 1;
    if (confirmedUtxos.length > 0) {
      const largestFirst = [...confirmedUtxos].sort((a, b) => b.value - a.value);
      let sum = 0;
      let used = 0;
      for (const u of largestFirst) {
        sum += u.value;
        used++;
        if (sum >= costFor(used)) break;
      }
      // Still short: the creator tops up, and that top-up is one more input.
      inputCount = sum >= costFor(used) ? used : used + 1;
    }
    const estimatedCostSats = costFor(inputCount);

    return json({
      address,
      network,
      confirmedUtxos,
      unconfirmedSats: utxos.unconfirmedSats,
      estimatedCostSats,
    });
  };

  /**
   * GET /api/btc/network — the network these routes actually speak, so the
   * browser can refuse to show a deposit address when its build-time
   * VITE_BTC_NETWORK disagrees with the server's runtime BTC_NETWORK. The two
   * flags are set in different places at different times; a skew silently
   * points a real-BTC deposit at an address this deploy can never spend.
   * Unauthenticated: it is public deploy config, and the client needs it
   * before any of the gated flows run.
   */
  const networkInfo: Handler = async () =>
    json({ network: deps.network ?? 'testnet', faucet: !!deps.faucet });

  /** Parse broadcast-ready raw tx hex, or null. */
  function parseRawTx(txHex: string): btc.Transaction | null {
    try {
      return btc.Transaction.fromRaw(hex.decode(txHex), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });
    } catch {
      return null;
    }
  }

  /**
   * Broadcast, treating an already-known tx as success. Returns an error
   * message or null. Accepts undefined so callers can pass a retired record's
   * (absent) hex without a narrowing dance — there is simply nothing to push.
   */
  async function broadcastIdempotent(txHex: string | undefined): Promise<string | null> {
    if (!txHex) return 'no recovery artifact for this record';
    try {
      await provider.broadcastTransaction(txHex);
      return null;
    } catch (e) {
      if (isAlreadyKnownTxError(e)) return null;
      return (e as Error).message;
    }
  }

  /**
   * Make `rec` the live pair for its funding outpoint: retire the current
   * rival (its commit conflicts with rec's, so at most one can ever land) and
   * clear rec's superseded flag. Used whenever evidence shows a superseded
   * pair is actually the one on the network (confirmed commit, or a
   * successful re-broadcast of its txs).
   */
  function reclaimOutpoint(store: InscriptionsStore, sub: string, rec: InscriptionRecord): void {
    // Every outpoint this pair spends, not just the identity one: a rival that
    // overlaps on ANY input conflicts with it on the network.
    for (const rival of store.findByOutpoints(sub, outpointsOf(rec))) {
      if (rival.commitTxId !== rec.commitTxId) store.supersede(sub, rival.commitTxId);
    }
    store.reinstate(sub, rec.commitTxId);
  }

  /**
   * POST /api/btc/inscribe — the stranded-funds fix. Accepts the SIGNED commit
   * and reveal, re-checks the SDK's step-5b invariants server-side (a client
   * bug must not broadcast a bad tx through our proxy), persists both txs
   * under the user BEFORE broadcasting, then broadcasts commit → reveal.
   * A reveal failure is still a 200 with status 'commit_broadcast': the reveal
   * is persisted and completes via rebroadcast — nothing is stranded.
   */
  const inscribe: Handler = async (req, _url, clientIp) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(clientIp);
    if (limited) return limited;
    if (!deps.inscriptions) return json({ error: 'inscriptions_unavailable' }, 503);
    const store = deps.inscriptions;

    // Size cap enforced WHILE streaming (bounds inscription content too, and
    // holds even for chunked requests that omit Content-Length).
    const bodyText = await readBodyCapped(req, MAX_INSCRIBE_BODY_BYTES);
    if (bodyText === null) return json({ error: 'payload_too_large' }, 413);

    type DeclaredUtxo = { txid?: string; vout?: number; value?: number };
    let body: {
      signedCommitHex?: string;
      revealTxHex?: string;
      /** Every funding UTXO the commit spends, in input order. */
      fundingUtxos?: DeclaredUtxo[];
      /** LEGACY singular shape — still posted by a cached browser bundle. */
      fundingUtxo?: DeclaredUtxo;
      changeAddress?: string;
    };
    try {
      body = JSON.parse(bodyText) as typeof body;
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const { signedCommitHex, revealTxHex, changeAddress } = body;
    const declared: DeclaredUtxo[] = Array.isArray(body.fundingUtxos)
      ? body.fundingUtxos
      : body.fundingUtxo
        ? [body.fundingUtxo]
        : [];
    const hexRe = /^(?:[0-9a-fA-F]{2})+$/;
    if (
      typeof signedCommitHex !== 'string' || !hexRe.test(signedCommitHex) ||
      typeof revealTxHex !== 'string' || !hexRe.test(revealTxHex) ||
      declared.length === 0 ||
      declared.some((u) => !u || typeof u.txid !== 'string' || typeof u.vout !== 'number') ||
      typeof changeAddress !== 'string' || !changeAddress
    ) {
      return json({ error: 'bad_request' }, 400);
    }
    const outpoints = declared.map((u) => `${u.txid!.toLowerCase()}:${u.vout!}`);
    if (new Set(outpoints).size !== outpoints.length) {
      return json({ error: 'bad_request', message: 'Duplicate funding outpoint.' }, 400);
    }

    // Re-check the SDK's step-5b invariants: the commit must spend EXACTLY the
    // declared funding set, IN ORDER (the did:btco sat is the first sat of
    // input 0, so a reordered input moves the identity), with at most two
    // outputs (commit output + optional change), and the reveal must spend the
    // commit's vout 0.
    const commit = parseRawTx(signedCommitHex);
    if (!commit) return json({ error: 'bad_commit_tx' }, 400);
    if (commit.inputsLength !== outpoints.length || commit.outputsLength < 1 || commit.outputsLength > 2) {
      return json({ error: 'commit_invariant_violation', message: 'Commit must spend exactly the declared funding UTXOs and have 1-2 outputs.' }, 400);
    }
    const inputsMatch = outpoints.every((expected, i) => {
      const input = commit.getInput(i);
      const txid = input.txid ? hex.encode(input.txid).toLowerCase() : '';
      return `${txid}:${input.index}` === expected;
    });
    if (!inputsMatch) {
      return json({ error: 'commit_invariant_violation', message: 'Commit inputs do not match the declared funding UTXOs (in order).' }, 400);
    }
    const commitTxId = commit.id;

    const reveal = parseRawTx(revealTxHex);
    if (!reveal) return json({ error: 'bad_reveal_tx' }, 400);
    // Shape before indexing: getInput(0) throws on an input-less tx. No raw
    // hex can currently reach here with zero inputs (fromRaw rejects it — the
    // 0x00 input count is read as the segwit marker), so this is defensive
    // only, kept symmetric with the commit path above.
    if (reveal.inputsLength !== 1) {
      return json({ error: 'reveal_invariant_violation', message: 'Reveal must spend the commit transaction output 0.' }, 400);
    }
    const revealInput = reveal.getInput(0);
    const revealInputTxid = revealInput?.txid ? hex.encode(revealInput.txid).toLowerCase() : '';
    if (revealInputTxid !== commitTxId.toLowerCase() || revealInput.index !== 0) {
      return json({ error: 'reveal_invariant_violation', message: 'Reveal must spend the commit transaction output 0.' }, 400);
    }
    const revealTxId = reveal.id;

    // Consume a per-user slot only now that the request has proven valid —
    // malformed submissions must not burn the hourly cap for free (mirrors
    // the funding route's validate-before-consuming rule).
    const perUser = inscribeUserLimiter.check(sub);
    if (!perUser.allowed) {
      return json({ error: 'inscribe_user_cap' }, 429, {
        'Retry-After': String(Math.ceil(perUser.retryAfterMs / 1000)),
      });
    }

    // Outpoint idempotency: one pending inscription per funding UTXO. A retry
    // of the SAME pair continues below (create is a no-op). A DIFFERENT pair
    // on the same outpoint may SUPERSEDE a pair whose commit broadcast failed
    // (status 'signed' — rebuilt commits always have fresh txids, so refusing
    // outright would deadlock the outpoint forever); anything later is a live
    // double-spend attempt → 409. Superseding is strictly NON-DESTRUCTIVE: a
    // failed broadcast call can be ambiguous (the commit may have reached the
    // network anyway), so the old record — carrying the ONLY copy of its
    // reveal — is kept forever, just flagged so the outpoint frees up. And if
    // the old commit is already CONFIRMED on-chain, superseding is refused:
    // the outpoint is genuinely spent, and the old pair's reveal (via
    // rebroadcast) is the one true recovery path.
    // With multi-input funding the claim is a SET: any live record sharing any
    // declared outpoint conflicts. Only an EXACT set match can be superseded —
    // an overlapping-but-unequal set has no safe replacement (the rebuilt pair
    // would not conflict with the old one on every input, so both could land
    // and one reveal would be stranded).
    const rivals = store.findByOutpoints(sub, outpoints).filter((r) => r.commitTxId !== commitTxId);
    const sameSet = (r: InscriptionRecord) => {
      const theirs = outpointsOf(r);
      return theirs.length === outpoints.length && theirs.every((o) => outpoints.includes(o));
    };
    if (rivals.length > 1 || (rivals.length === 1 && !sameSet(rivals[0]))) {
      return json({ error: 'outpoint_pending', commitTxId: rivals[0].commitTxId }, 409);
    }
    const existing = rivals[0];
    if (existing) {
      if (existing.status !== 'signed') {
        return json({ error: 'outpoint_pending', commitTxId: existing.commitTxId }, 409);
      }
      try {
        const st = await provider.getTransactionStatus(existing.commitTxId);
        if (st?.confirmed) {
          store.setStatus(sub, existing.commitTxId, 'commit_broadcast');
          return json({ error: 'outpoint_pending', commitTxId: existing.commitTxId }, 409);
        }
      } catch {
        // No lookup — fall through: superseding stays safe because nothing
        // is deleted (an unconfirmed-but-broadcast old commit conflicts with
        // the new one on the network; whichever confirms, its reveal is here).
      }
      store.supersede(sub, existing.commitTxId);
    }

    // Persist BEFORE any broadcast — the whole point: from here on, recovery
    // never depends on the client (or this request) surviving.
    const at = new Date(now()).toISOString();
    const record: InscriptionRecord = {
      commitTxId,
      revealTxId,
      inscriptionId: `${revealTxId}i0`,
      signedCommitHex,
      revealTxHex,
      fundingOutpoints: outpoints,
      changeAddress,
      status: 'signed',
      createdAt: at,
      updatedAt: at,
    };
    try {
      store.create(sub, record);
    } catch (e) {
      return json({ error: 'store_error', message: (e as Error).message }, 500);
    }

    const commitErr = await broadcastIdempotent(signedCommitHex);
    if (commitErr) {
      // Nothing on-chain (or already there — that path returns null): the pair
      // stays persisted as 'signed' and a rebroadcast can retry safely.
      return json({ error: 'commit_broadcast_failed', message: commitErr, commitTxId }, 502);
    }
    store.setStatus(sub, commitTxId, 'commit_broadcast');

    const revealErr = await broadcastIdempotent(revealTxHex);
    if (revealErr) {
      return json({ commitTxId, revealTxId, inscriptionId: record.inscriptionId, status: 'commit_broadcast' });
    }
    store.setStatus(sub, commitTxId, 'reveal_broadcast');
    return json({ commitTxId, revealTxId, inscriptionId: record.inscriptionId, status: 'reveal_broadcast' });
  };

  /**
   * GET /api/btc/inscribe — the user's inscription records (no tx hex; ids +
   * status only). Three best-effort reconciliation passes ride on this poll,
   * in priority order under one shared lookup budget, so EVERY stranded state
   * converges automatically — the manual Finish button is a shortcut, never
   * the only path:
   *
   * 1. SUPERSEDED pairs whose commit turns out to have CONFIRMED on-chain
   *    (the ambiguous broadcast that landed and then WON the outpoint race)
   *    are auto-recovered: the rival is retired, the winner reinstated, and
   *    its persisted reveal broadcast.
   * 2. LIVE pairs stuck at commit_broadcast (reveal broadcast failed at some
   *    point) get their reveal completed from the persisted copy once their
   *    commit confirms.
   * 3. Broadcast-but-unconfirmed reveals get a confirmation check; a
   *    confirmed reveal is persisted as 'confirmed' (sticky, and its recovery
   *    artifacts are dropped), so each record costs at most a handful of
   *    provider lookups over its lifetime. One that is STILL unconfirmed
   *    after REVEAL_REBROADCAST_AFTER_MS is re-pushed from the persisted
   *    copy — a reveal evicted from the mempool has no other way back.
   */
  const inscribeList: Handler = async (req, _url, clientIp) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(clientIp) ?? quotaCapped(sub);
    if (limited) return limited;
    if (!deps.inscriptions) return json({ error: 'inscriptions_unavailable' }, 503);
    const store = deps.inscriptions;
    let records = store.list(sub);
    // Bound the per-request provider fan-out on top of the per-user quota cap
    // above. The worklist is PRIORITIZED: superseded reconciliation goes
    // first — those pairs carry committed funds and have NO manual recovery
    // surface (the UI hides them by design), so ordinary confirmation polling
    // for newer records must never starve them. Within each pass a ROTATING
    // cursor picks where the scan starts, so even a backlog larger than the
    // whole budget is fully covered across successive polls — no record can
    // sit permanently behind the budget.
    let changed = false;
    const newestFirst = [...records].reverse();
    // A superseded pair whose outpoint already carries a CONFIRMED record is
    // terminally dead — its commit double-spends a confirmed tx and can never
    // land — so it is excluded from reconciliation instead of costing a
    // pointless provider lookup on every poll for the rest of time.
    const confirmedOutpoints = new Set(
      newestFirst.filter((r) => r.status === 'confirmed').flatMap(outpointsOf)
    );
    // Any single spent input is enough to kill a rival commit for good.
    const isDead = (r: InscriptionRecord) => outpointsOf(r).some((o) => confirmedOutpoints.has(o));
    const cursors = cursorsFor(sub);
    // Terminally-dead superseded pairs still holding hex: retire them (drop
    // the recovery artifacts, keep the row) so they stop counting against the
    // user's pending cap and stop costing disk. Costs no provider lookup.
    for (const r of newestFirst) {
      if (r.superseded && !r.retired && r.revealTxHex && isDead(r)) {
        store.retire(sub, r.commitTxId);
        changed = true;
      }
    }
    const supersededPending = rotate(
      newestFirst.filter(
        (r) =>
          r.superseded &&
          r.status !== 'confirmed' &&
          !r.retired &&
          !!r.revealTxHex &&
          !isDead(r)
      ),
      cursors.superseded
    );
    // Live pairs stuck at commit_broadcast (their reveal broadcast failed —
    // whether in the original submission, a rebroadcast, or after a reclaim):
    // once THEIR commit confirms, the persisted reveal is completed here
    // automatically, so no state depends on the manual Finish button.
    const liveStuck = rotate(
      newestFirst.filter((r) => !r.superseded && r.status === 'commit_broadcast' && !!r.revealTxHex),
      cursors.stuck
    );
    const liveUnconfirmed = rotate(
      newestFirst.filter((r) => !r.superseded && r.status === 'reveal_broadcast'),
      cursors.confirm
    );
    let lookups = 0;
    for (const r of supersededPending) {
      if (lookups >= 5) break;
      lookups++;
      cursors.superseded++;
      try {
        // ONE question decides a contested outpoint, whatever the pair's
        // stored status: did THIS pair's commit confirm? (A reveal can only
        // ever confirm on top of its own commit, so the commit check covers
        // every superseded state — including reveal_broadcast pairs whose
        // reveal never actually landed.) If yes: retire the rival (its commit
        // conflicts with a confirmed tx), reinstate this pair, and complete
        // it by (re)broadcasting the persisted reveal idempotently; the next
        // poll's confirmation pass then walks it to 'confirmed'.
        const st = await provider.getTransactionStatus(r.commitTxId);
        if (!st?.confirmed) continue;
        reclaimOutpoint(store, sub, r);
        const revealErr = await broadcastIdempotent(r.revealTxHex);
        store.setStatus(sub, r.commitTxId, revealErr ? 'commit_broadcast' : 'reveal_broadcast');
        changed = true;
      } catch {
        // Lookup unsupported/down — leave the record as stored.
      }
    }
    for (const r of liveStuck) {
      if (lookups >= 5) break;
      lookups++;
      cursors.stuck++;
      try {
        const st = await provider.getTransactionStatus(r.commitTxId);
        if (!st?.confirmed) continue;
        const revealErr = await broadcastIdempotent(r.revealTxHex);
        if (!revealErr) {
          store.setStatus(sub, r.commitTxId, 'reveal_broadcast');
          changed = true;
        }
      } catch {
        // Lookup unsupported/down — the manual Finish button still covers it.
      }
    }
    for (const r of liveUnconfirmed) {
      if (lookups >= 5) break;
      lookups++;
      cursors.confirm++;
      try {
        const st = await provider.getTransactionStatus(r.revealTxId);
        if (st?.confirmed) {
          store.setStatus(sub, r.commitTxId, 'confirmed');
          changed = true;
          continue;
        }
        // Not confirmed, and nothing else in the system ever re-pushes a
        // reveal once it is marked broadcast. A reveal built at a rate that a
        // fee spike leaves behind gets EVICTED from the mempool and would
        // then never land — the commit's funds sit in a P2TR output nobody
        // can reach (the reveal key is ephemeral, so it can never be replaced
        // either). Re-push the persisted copy periodically: idempotent, free,
        // and a no-op for a reveal that is simply waiting for a block.
        // Throttle on rebroadcastAt, NOT updatedAt: updatedAt is how long the
        // record has been stuck at this status, which is what the UI reads to
        // decide whether to offer a manual retry. Refreshing it here would
        // reset that clock every 30 minutes and the manual path would never
        // surface. The status has not changed, so neither should updatedAt.
        const lastPush = Date.parse(r.rebroadcastAt ?? r.updatedAt);
        if (r.revealTxHex && now() - lastPush >= REVEAL_REBROADCAST_AFTER_MS) {
          await broadcastIdempotent(r.revealTxHex);
          store.markRebroadcast(sub, r.commitTxId);
        }
      } catch {
        // Lookup unsupported/down — report the stored status.
      }
    }
    if (changed) records = store.list(sub);
    const inscriptions = records.map((r) => ({
      commitTxId: r.commitTxId,
      revealTxId: r.revealTxId,
      inscriptionId: r.inscriptionId,
      // Singular stays the IDENTITY outpoint so existing clients keep working.
      fundingOutpoint: outpointsOf(r)[0],
      fundingOutpoints: outpointsOf(r),
      status: r.status,
      ...(r.superseded ? { superseded: true } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    return json({ inscriptions });
  };

  /**
   * POST /api/btc/inscribe/rebroadcast { commitTxId } — finish a stranded
   * inscription from server state. Idempotent: an already-seen tx counts as
   * broadcast, and the reveal is checked against the chain first.
   */
  const inscribeRebroadcast: Handler = async (req, _url, clientIp) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(clientIp) ?? quotaCapped(sub);
    if (limited) return limited;
    if (!deps.inscriptions) return json({ error: 'inscriptions_unavailable' }, 503);
    const store = deps.inscriptions;

    const { commitTxId } = (await req.json().catch(() => ({}))) as { commitTxId?: string };
    if (typeof commitTxId !== 'string' || !commitTxId) return json({ error: 'bad_request' }, 400);
    const rec = store.get(sub, commitTxId);
    if (!rec) return json({ error: 'not_found' }, 404);
    if (rec.status === 'confirmed') {
      return json({ commitTxId, revealTxId: rec.revealTxId, inscriptionId: rec.inscriptionId, status: 'confirmed' });
    }
    // Retired: the record is terminal (its outpoint was won by a pair that
    // confirmed), so the recovery artifacts were dropped. Nothing to push.
    if (!rec.revealTxHex) {
      return json({ error: 'not_recoverable', message: 'This pair is terminal — its funding outpoint was spent by an inscription that confirmed.' }, 410);
    }

    // Rebroadcasting a SUPERSEDED pair is an explicit choice of this pair for
    // its funding outpoint: any success below must also swap the roles —
    // reinstate this record as the live one and retire the rival — or the
    // store would keep a pair marked superseded+reveal_broadcast that both
    // reconciliation branches skip, with a conflicting rival still "live".
    // (If the rival later wins on-chain anyway, the list poll's
    // confirmation-driven reconciliation swaps the roles back.)
    const reclaimIfSuperseded = () => {
      if (rec.superseded) reclaimOutpoint(store, sub, rec);
    };

    // Already CONFIRMED on-chain? Then just record that and succeed. An
    // unknown or merely-unconfirmed reveal falls through to the (idempotent)
    // rebroadcast below — QuickNode reports both as { confirmed: false }, so
    // presence alone cannot distinguish "in mempool" from "never broadcast".
    try {
      const st = await provider.getTransactionStatus(rec.revealTxId);
      if (st?.confirmed) {
        reclaimIfSuperseded();
        store.setStatus(sub, commitTxId, 'confirmed');
        return json({ commitTxId, revealTxId: rec.revealTxId, inscriptionId: rec.inscriptionId, status: 'confirmed' });
      }
    } catch {
      // No lookup support / transport failure — fall through to rebroadcast.
    }

    if (rec.status === 'signed' && rec.signedCommitHex) {
      const commitErr = await broadcastIdempotent(rec.signedCommitHex);
      if (commitErr) return json({ error: 'commit_broadcast_failed', message: commitErr, commitTxId }, 502);
      reclaimIfSuperseded();
      store.setStatus(sub, commitTxId, 'commit_broadcast');
    }
    const revealErr = await broadcastIdempotent(rec.revealTxHex);
    if (revealErr) {
      return json({ commitTxId, revealTxId: rec.revealTxId, inscriptionId: rec.inscriptionId, status: 'commit_broadcast' });
    }
    reclaimIfSuperseded();
    store.setStatus(sub, commitTxId, 'reveal_broadcast');
    return json({ commitTxId, revealTxId: rec.revealTxId, inscriptionId: rec.inscriptionId, status: 'reveal_broadcast' });
  };

  return { funding, sat, fee, broadcast, deposit, networkInfo, inscribe, inscribeList, inscribeRebroadcast };
}

export type BitcoinRoutes = ReturnType<typeof createBitcoinRoutes>;

/**
 * Raw-key faucet signer: decode a testnet WIF, derive its tb1q address, and
 * return a signer that signs+finalizes the funding tx locally. Simplest to
 * operate for a testnet4 demo (worthless coins) — no Turnkey wallet needed.
 */
export function rawKeyFaucetSigner(wif: string): { address: string; signFundingTx: FaucetTxSigner } {
  const raw = base58check(sha256).decode(wif.trim());
  const version = raw[0];
  if (version !== 0xef) {
    throw new Error(`BTC_FAUCET_WIF must be a testnet WIF (version 0xEF); got 0x${version.toString(16)}.`);
  }
  // P2WPKH requires a COMPRESSED key → the WIF must carry the 0x01 compression
  // flag (34 bytes total). An uncompressed WIF would derive a different address
  // than intended, so reject it rather than silently mismatch.
  if (raw.length !== 34 || raw[33] !== 0x01) {
    throw new Error('BTC_FAUCET_WIF must be a COMPRESSED testnet WIF (P2WPKH needs a compressed key).');
  }
  const privateKey = raw.slice(1, 33);
  const pub = secp256k1.getPublicKey(privateKey, true);
  const address = btc.p2wpkh(pub, btc.TEST_NETWORK).address!;
  const signFundingTx: FaucetTxSigner = async (tx) => {
    tx.sign(privateKey);
    tx.finalize();
    return hex.encode(tx.extract());
  };
  return { address, signFundingTx };
}

/**
 * Turnkey-org faucet signer: signs the funding tx via Turnkey signTransaction
 * (no raw key on the server) and finalizes locally. Requires a Turnkey wallet
 * holding the faucet address.
 */
export function turnkeyFaucetSigner(turnkey: Turnkey, address: string): FaucetTxSigner {
  return async (tx) => {
    const unsignedHex = hex.encode(tx.toPSBT());
    const result = await turnkey.apiClient().signTransaction({
      organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
      signWith: address,
      unsignedTransaction: unsignedHex,
      type: 'TRANSACTION_TYPE_BITCOIN',
    } as never);
    const signed =
      (result as { activity?: { result?: { signTransactionResult?: { signedTransaction?: string } } } })
        .activity?.result?.signTransactionResult?.signedTransaction;
    if (!signed) throw new Error('Turnkey signTransaction returned no signedTransaction');
    return maybeFinalize(signed);
  };
}

/** Pass raw tx hex through; finalize a PSBT (base64 or hex) into raw hex. */
function maybeFinalize(signed: string): string {
  // A finalized raw tx parses via fromRaw and re-serializes unchanged.
  try {
    const asRaw = btc.Transaction.fromRaw(hex.decode(signed), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    return hex.encode(asRaw.extract());
  } catch { /* not raw hex — try PSBT below */ }
  const bytes = /^[0-9a-fA-F]+$/.test(signed) ? hex.decode(signed) : base64.decode(signed);
  const tx = btc.Transaction.fromPSBT(bytes, { allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.finalize();
  return hex.encode(tx.extract());
}
