/**
 * Server Bitcoin routes: a Turnkey-org faucet + thin QuickNode proxies.
 *
 * NO raw private key on the server: the faucet is a Turnkey-org wallet, signed
 * with the SAME Turnkey API creds auth already uses. The user's inscription is
 * signed in the browser by the user's own Turnkey session key. Every route is
 * auth-gated (JWT cookie) + rate-limited. The faucet signs ONLY its own funding
 * tx to a logged-in user's testnet address — never a general signing oracle.
 */
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import type { Turnkey } from '@turnkey/sdk-server';
import { verifyToken } from '@originals/auth/server';
import type { OrdinalsProvider } from '@originals/sdk';
import { isValidBitcoinAddress } from '@originals/sdk';
import { json, type Handler } from './router';
import { extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';

export function isBitcoinConfigured(): boolean {
  return (
    !!process.env.QUICKNODE_ENDPOINT &&
    !!process.env.BTC_FAUCET_WALLET_ID &&
    !!process.env.BTC_FAUCET_ADDRESS
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

export function createBitcoinRoutes(deps: {
  turnkey: Turnkey;
  jwtSecret: string;
  provider: OrdinalsProvider | FaucetProvider;
  faucet: { walletId: string; address: string };
  faucetSats?: number;
  now?: () => number;
}): { funding: Handler; sat: Handler; fee: Handler; broadcast: Handler } {
  const faucetSats = deps.faucetSats ?? 20_000;
  const ipLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
  const userLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 }); // 5 fundings / user / hour
  const provider = deps.provider as FaucetProvider;

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
    if (!authSub(req)) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
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
    if (!authSub(req)) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
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
    if (!authSub(req)) return json({ error: 'unauthorized' }, 401);
    const limited = rateLimited(req);
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
      faucetUtxos = await provider.getSpendableUtxos(deps.faucet.address);
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
        witnessUtxo: { script: hex.decode(u.scriptPubKey), amount: BigInt(u.value) },
      });
    }
    tx.addOutputAddress(address, BigInt(faucetSats), btc.TEST_NETWORK);
    if (change > 330) tx.addOutputAddress(deps.faucet.address, BigInt(change), btc.TEST_NETWORK);

    // 3) Sign with the faucet Turnkey-org wallet (unsigned PSBT hex → Turnkey →
    //    broadcast-ready hex). NO raw key: Turnkey holds the faucet key.
    const unsignedHex = hex.encode(tx.toPSBT());
    let signedTxHex: string;
    try {
      const result = await deps.turnkey.apiClient().signTransaction({
        organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
        signWith: deps.faucet.address,
        unsignedTransaction: unsignedHex,
        type: 'TRANSACTION_TYPE_BITCOIN',
      } as never);
      // Turnkey returns either broadcast-ready hex or a partially-signed PSBT.
      const signed =
        (result as { activity?: { result?: { signTransactionResult?: { signedTransaction?: string } } } })
          .activity?.result?.signTransactionResult?.signedTransaction;
      if (!signed) throw new Error('Turnkey signTransaction returned no signedTransaction');
      // If Turnkey returned a PSBT, finalize it; if already raw hex, pass through.
      signedTxHex = maybeFinalize(signed);
    } catch (e) {
      return json({ error: 'faucet_sign_failed', message: (e as Error).message }, 502);
    }

    // The funded outpoint is vout 0 (the user output). Capture its scriptPubKey
    // now — the SDK's createCommitTransaction REQUIRES it on the fundingUtxo to
    // set the segwit witnessUtxo (it throws "missing scriptPubKey" otherwise).
    const userScript = tx.getOutput(0).script;
    if (!userScript) return json({ error: 'funding_build_failed', message: 'No user output script.' }, 500);
    const scriptPubKey = hex.encode(userScript);

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

  return { funding, sat, fee, broadcast };
}

export type BitcoinRoutes = ReturnType<typeof createBitcoinRoutes>;

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
