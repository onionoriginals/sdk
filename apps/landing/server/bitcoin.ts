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
import type { InscriptionsStore, InscriptionRecord } from './inscriptions-store';

/** The server-side network flag: BTC_NETWORK=mainnet|testnet4 (default testnet4). */
export function serverBtcNetwork(): 'mainnet' | 'testnet4' {
  return process.env.BTC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet4';
}

export function isBitcoinConfigured(): boolean {
  if (!process.env.QUICKNODE_ENDPOINT) return false;
  // Mainnet is creator-pays: no faucet env needed (and none is mounted).
  if (serverBtcNetwork() === 'mainnet') return true;
  return (
    !!process.env.BTC_FAUCET_ADDRESS &&
    (!!process.env.BTC_FAUCET_WIF || !!process.env.BTC_FAUCET_WALLET_ID)
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
 * True when a broadcast rejection means the transaction is ALREADY on the
 * network — success for our idempotent retry purposes. Bitcoin Core surfaces
 * these as "txn-already-in-mempool", "txn-already-known", and "Transaction
 * already in block chain" (a conflicting-spend rejection says "conflict",
 * never "already", so it is not matched).
 */
export function isAlreadyKnownTxError(e: unknown): boolean {
  return /already/i.test((e as Error)?.message ?? '');
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
  inscribe: Handler;
  inscribeList: Handler;
  inscribeRebroadcast: Handler;
} {
  const faucetSats = deps.faucetSats ?? 20_000;
  const now = deps.now ?? (() => Date.now());
  const ipLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const userLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 }); // 5 fundings / user / hour
  // Real-spend + QuickNode-quota routes get their own per-user caps: the cost
  // vector on mainnet is the user's BTC and our API quota, not the faucet.
  const inscribeUserLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
  // Shared per-user cap for the proxy reads/broadcasts that burn QuickNode
  // quota (sat lookup, fee estimate, raw broadcast, deposit polls).
  const quotaUserLimiter = createRateLimiter({ limit: 120, windowMs: 60 * 60_000 });
  const provider = deps.provider as FaucetProvider;

  // 60s fee-estimate cache for the deposit poll (see the deposit handler).
  let feeCache: { at: number; rate: number } | null = null;

  // Rotating scan-start cursors for the list poll's two reconciliation
  // passes. Each processed item advances its cursor, so successive polls
  // start further along the (stably ordered) worklist — a backlog larger
  // than the per-poll lookup budget is still fully covered over a few polls
  // instead of the same head items consuming the budget forever.
  let supersededCursor = 0;
  let confirmCursor = 0;
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

  // Best-effort IP key (behind the auth gate + per-user cap, which are the real
  // protection). X-Forwarded-For is spoofable, so the per-user limiter keyed on
  // the JWT `sub` — not this — is what bounds faucet abuse.
  function clientIp(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
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

  function rateLimited(req: Request): Response | null {
    const rl = ipLimiter.check(clientIp(req));
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, {
        'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }
    return null;
  }

  const sat: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req) ?? quotaCapped(sub);
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

  const fee: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req) ?? quotaCapped(sub);
    if (limited) return limited;
    const { blocks } = (await req.json().catch(() => ({}))) as { blocks?: number };
    try {
      const feeRate = await provider.estimateFee(typeof blocks === 'number' ? blocks : 1);
      return json({ feeRate });
    } catch (e) {
      return json({ error: 'fee_estimate_failed', message: (e as Error).message }, 502);
    }
  };

  const broadcast: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req) ?? quotaCapped(sub);
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

  const funding: Handler = async (req) => {
    // Creator-pays deploys (mainnet) have no faucet at all — the route is not
    // mounted there, and this guard keeps a miswired mount fail-closed.
    const faucet = deps.faucet;
    if (!faucet) return json({ error: 'faucet_unavailable' }, 404);
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
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
    let feeRate = 1;
    try { feeRate = Math.max(1, Math.ceil(await provider.estimateFee(1))); } catch { /* floor */ }
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
  const deposit: Handler = async (req, url) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
    if (limited) return limited;
    if (!deps.depositApi) return json({ error: 'deposit_unavailable' }, 503);
    const network = deps.network ?? 'testnet';

    const address = url.searchParams.get('address') ?? '';
    if (!address || !isValidBitcoinAddress(address, network)) {
      return json({ error: 'bad_address', message: `A ${network} P2WPKH address is required.` }, 400);
    }
    // Optional content-size hint tightens the estimate; clamped to the same
    // ceiling the inscribe route enforces.
    const contentBytesRaw = Number(url.searchParams.get('contentBytes'));
    const contentBytes = Number.isFinite(contentBytesRaw) && contentBytesRaw > 0
      ? Math.min(contentBytesRaw, MAX_INSCRIBE_BODY_BYTES / 2)
      : 5_000;

    let utxos: Awaited<ReturnType<typeof fetchAddressUtxos>>;
    try {
      utxos = await fetchAddressUtxos({ api: deps.depositApi, address, network, fetchImpl: deps.fetchImpl });
    } catch (e) {
      return json({ error: 'utxo_lookup_failed', message: (e as Error).message }, 502);
    }
    // The UI polls this route while waiting for a deposit; cache the fee
    // estimate briefly so polling costs mempool.space reads (free), not
    // QuickNode quota on every tick.
    let feeRate = 1;
    if (feeCache && now() - feeCache.at < 60_000) {
      feeRate = feeCache.rate;
    } else {
      try {
        feeRate = Math.max(1, Math.ceil(await provider.estimateFee(1)));
        feeCache = { at: now(), rate: feeRate };
      } catch { /* floor */ }
    }
    // Commit ≈ 153 vB (P2WPKH input, P2TR commit output, P2WPKH change) and
    // reveal ≈ 111 vB + the witness-discounted envelope (content + ~300 bytes
    // of tags/script overhead) — the same shape commit.ts estimates precisely
    // once the content exists. 1.5× buffer absorbs a fee move between the
    // deposit and the broadcast; postage rides on top.
    const commitVB = 153;
    const revealVB = 111 + Math.ceil((contentBytes + 300) / 4);
    const estimatedCostSats = Math.ceil(feeRate * (commitVB + revealVB) * 1.5) + 546;

    return json({
      address,
      confirmedUtxos: utxos.confirmed,
      unconfirmedSats: utxos.unconfirmedSats,
      estimatedCostSats,
    });
  };

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

  /** Broadcast, treating an already-known tx as success. Returns an error message or null. */
  async function broadcastIdempotent(txHex: string): Promise<string | null> {
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
  function reclaimOutpoint(
    store: InscriptionsStore,
    sub: string,
    rec: { commitTxId: string; fundingOutpoint: string }
  ): void {
    const rival = store.findByOutpoint(sub, rec.fundingOutpoint);
    if (rival && rival.commitTxId !== rec.commitTxId) store.supersede(sub, rival.commitTxId);
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
  const inscribe: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
    if (limited) return limited;
    if (!deps.inscriptions) return json({ error: 'inscriptions_unavailable' }, 503);
    const store = deps.inscriptions;

    // Size cap enforced WHILE streaming (bounds inscription content too, and
    // holds even for chunked requests that omit Content-Length).
    const bodyText = await readBodyCapped(req, MAX_INSCRIBE_BODY_BYTES);
    if (bodyText === null) return json({ error: 'payload_too_large' }, 413);

    let body: {
      signedCommitHex?: string;
      revealTxHex?: string;
      fundingUtxo?: { txid?: string; vout?: number; value?: number };
      changeAddress?: string;
    };
    try {
      body = JSON.parse(bodyText) as typeof body;
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const { signedCommitHex, revealTxHex, fundingUtxo, changeAddress } = body;
    const hexRe = /^(?:[0-9a-fA-F]{2})+$/;
    if (
      typeof signedCommitHex !== 'string' || !hexRe.test(signedCommitHex) ||
      typeof revealTxHex !== 'string' || !hexRe.test(revealTxHex) ||
      !fundingUtxo || typeof fundingUtxo.txid !== 'string' || typeof fundingUtxo.vout !== 'number' ||
      typeof changeAddress !== 'string' || !changeAddress
    ) {
      return json({ error: 'bad_request' }, 400);
    }

    // Re-check the SDK's step-5b invariants: the commit must spend EXACTLY the
    // declared funding outpoint (one input) with at most two outputs (commit
    // output + optional change), and the reveal must spend the commit's vout 0.
    const commit = parseRawTx(signedCommitHex);
    if (!commit) return json({ error: 'bad_commit_tx' }, 400);
    if (commit.inputsLength !== 1 || commit.outputsLength < 1 || commit.outputsLength > 2) {
      return json({ error: 'commit_invariant_violation', message: 'Commit must have exactly 1 input and 1-2 outputs.' }, 400);
    }
    const commitInput = commit.getInput(0);
    const commitInputTxid = commitInput.txid ? hex.encode(commitInput.txid).toLowerCase() : '';
    if (commitInputTxid !== fundingUtxo.txid.toLowerCase() || commitInput.index !== fundingUtxo.vout) {
      return json({ error: 'commit_invariant_violation', message: 'Commit input does not spend the declared funding UTXO.' }, 400);
    }
    const commitTxId = commit.id;

    const reveal = parseRawTx(revealTxHex);
    if (!reveal) return json({ error: 'bad_reveal_tx' }, 400);
    const revealInput = reveal.getInput(0);
    const revealInputTxid = revealInput?.txid ? hex.encode(revealInput.txid).toLowerCase() : '';
    if (reveal.inputsLength !== 1 || revealInputTxid !== commitTxId.toLowerCase() || revealInput.index !== 0) {
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
    const outpoint = `${fundingUtxo.txid.toLowerCase()}:${fundingUtxo.vout}`;
    const existing = store.findByOutpoint(sub, outpoint);
    if (existing && existing.commitTxId !== commitTxId) {
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
      fundingOutpoint: outpoint,
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
   * status only). Two best-effort reconciliation passes ride on this poll,
   * both bounded by one shared lookup budget:
   *
   * 1. Broadcast-but-unconfirmed reveals get a confirmation check; a
   *    confirmed reveal is persisted as 'confirmed' (sticky), so each record
   *    costs at most a handful of provider lookups over its lifetime.
   * 2. SUPERSEDED pairs whose commit turns out to have CONFIRMED on-chain
   *    (the ambiguous broadcast that landed and then WON the outpoint race)
   *    are auto-recovered: their reveal — the only one that can complete the
   *    inscription — is broadcast from the persisted copy, the record is
   *    reinstated as the live pair, and the rival (whose commit now
   *    double-spends a confirmed tx and can never land) is superseded in its
   *    place. No UI action needed; the routine /me poll drives it.
   */
  const inscribeList: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req) ?? quotaCapped(sub);
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
    const newestFirst = [...records].reverse();
    // A superseded pair whose outpoint already carries a CONFIRMED record is
    // terminally dead — its commit double-spends a confirmed tx and can never
    // land — so it is excluded from reconciliation instead of costing a
    // pointless provider lookup on every poll for the rest of time.
    const confirmedOutpoints = new Set(
      newestFirst.filter((r) => r.status === 'confirmed').map((r) => r.fundingOutpoint)
    );
    const supersededPending = rotate(
      newestFirst.filter(
        (r) =>
          r.superseded &&
          r.status !== 'confirmed' &&
          !confirmedOutpoints.has(r.fundingOutpoint)
      ),
      supersededCursor
    );
    const liveUnconfirmed = rotate(
      newestFirst.filter((r) => !r.superseded && r.status === 'reveal_broadcast'),
      confirmCursor
    );
    let lookups = 0;
    let changed = false;
    for (const r of supersededPending) {
      if (lookups >= 5) break;
      lookups++;
      supersededCursor++;
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
    for (const r of liveUnconfirmed) {
      if (lookups >= 5) break;
      lookups++;
      confirmCursor++;
      try {
        const st = await provider.getTransactionStatus(r.revealTxId);
        if (st?.confirmed) {
          store.setStatus(sub, r.commitTxId, 'confirmed');
          changed = true;
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
      fundingOutpoint: r.fundingOutpoint,
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
  const inscribeRebroadcast: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req) ?? quotaCapped(sub);
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

    if (rec.status === 'signed') {
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

  return { funding, sat, fee, broadcast, deposit, inscribe, inscribeList, inscribeRebroadcast };
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
