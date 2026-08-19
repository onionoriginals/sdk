# Landing auth server

Standalone Bun server exercising `@originals/auth` 2.0 email-OTP auth for the landing page.

## Run

1. Build the auth package: `cd ../../packages/auth && bun run build`
2. Copy env: from `apps/landing/`, run `cp server/.env.example .env` and fill in real
   Turnkey creds + `JWT_SECRET`.

   > **Important — env file placement.** The `.env.example` template lives in
   > `apps/landing/server/`, but the `dev:server` script runs
   > `bun run --watch server/index.ts` from `apps/landing/`, and Bun auto-loads `.env`
   > from the current working directory. So the filled-in env file **must** sit at
   > `apps/landing/.env` (not `apps/landing/server/.env`) or your creds will be
   > silently ignored. Running `cp server/.env.example .env` from `apps/landing/`
   > puts it in the right place.
3. From `apps/landing/`: `bun run dev:all` (starts the Bun server on :8787 and Vite on :5173).

The Vite dev server proxies `/api` → `http://localhost:8787`, so the browser is same-origin.

## Manual E2E checklist (real Turnkey)

Requires live `TURNKEY_*` creds, `JWT_SECRET`, and access to the target inbox.

- [ ] Click **Sign in**, enter your email, **Send code** → 200, code arrives by email.
- [ ] Enter the 6-digit code → modal closes, nav shows your email (cookie set).
- [ ] Reload the page → still signed in (`GET /api/me` succeeds from the httpOnly cookie).
- [ ] Enter a wrong code 5× → session destroyed, must request a new code.
- [ ] Click **Create your did:webvh** → a `did:webvh:…` string appears.
- [ ] **Sign out** → nav returns to **Sign in**; reload stays signed out.

## Notes
- Session storage is in-memory (lost on restart; single process). Not for production.
- Rate limiting is in-memory (per IP + per email); also single-process.

## Enabling real testnet4 inscription (Track B)

By default the demo's Inscribe step uses a mock provider. To make it a **real**
Bitcoin testnet4 inscription (worthless tBTC):

1. **QuickNode:** a testnet4 endpoint **with the Ordinals & Runes add-on** →
   `QUICKNODE_ENDPOINT`. Confirm the add-on covers testnet4 first:
   ```
   QUICKNODE_ENDPOINT=... BTC_FAUCET_ADDRESS=tb1q... \
     bun run apps/landing/scripts/check-quicknode-ordinals.ts
   ```
   If that fails, testnet4 inscription isn't viable on that endpoint (use a
   self-hosted ord+bitcoind instead).
2. **Faucet:** create a testnet4 P2WPKH (`tb1q…`) wallet, fund it from a public
   testnet4 faucet, and set `BTC_FAUCET_WIF` (the address's WIF) + `BTC_FAUCET_ADDRESS`.
   (Or use a Turnkey-org wallet via `BTC_FAUCET_WALLET_ID` instead of the WIF.)
   The faucet's confirmed UTXOs are read from mempool.space testnet4 — no add-on needed.
3. **Browser flag:** set `VITE_BTC_NETWORK=testnet4` and **rebuild** the SPA
   (`bun run build`) — Vite bakes it at build time; a runtime-only change does
   nothing. (Legacy `VITE_BTC_TESTNET=1` still works as an alias.)
4. Sign in → Create → Publish → Inscribe. The user's own Turnkey key signs the
   commit; the faucet funds it; the UI links the real tx on mempool.space/testnet4.

Bitcoin **mainnet** inscription (creator-pays — real BTC):

1. **QuickNode:** a mainnet endpoint **with the Ordinals & Runes add-on** →
   `QUICKNODE_ENDPOINT`, and `BTC_NETWORK=mainnet`. No faucet vars — the faucet
   route is not mounted on mainnet.
2. **Browser flag:** `VITE_BTC_NETWORK=mainnet` + rebuild the SPA.
3. Sign in → Create → Publish → the Inscribe step shows the user's own
   Turnkey-derived `bc1q…` deposit address and the estimated cost. They send
   BTC to it (from anywhere), wait for one confirmation, and inscribe: their
   key signs the commit, their UTXO pays, change + the inscribed sat return to
   their address. Signed commit+reveal pairs are persisted server-side BEFORE
   broadcast (`POST /api/btc/inscribe`), so a dying tab can never strand
   committed funds — `POST /api/btc/inscribe/rebroadcast` finishes them.

**The two network flags must match.** `VITE_BTC_NETWORK` is baked into the SPA
at build time; `BTC_NETWORK` is read by the server at runtime. The browser
checks them against each other via `GET /api/btc/network` before it will show
anyone a deposit address — a skew disables inscribing and prints a config
error instead, because BTC sent to an address the server does not serve is not
spendable through this app.

Recovery is automatic. The `/me` list poll reconciles every stranded state:
a commit that never broadcast, a reveal that never broadcast, and a reveal
that broadcast but never confirmed (evicted from the mempool — re-pushed from
the persisted copy after 30 minutes). "Finish inscription" on `/me` is the
manual shortcut, and the server warns hourly about anything still un-landed
after 24h. Note the reveal cannot be fee-bumped by replacement at all — its
signing key is ephemeral — so rebroadcast (or CPFP on the postage output) is
the only path.

A creator is bound to ONE deposit address per network on first use, so the
deposit route can't be used as a UTXO-lookup proxy for arbitrary addresses.
Their own inscription outputs are excluded from the spendable set, so an
existing inscription's sat can never be consumed as funding for a new one.

Everything is gated: with any of the above absent, `/api/btc/*` is unmounted and
the demo silently falls back to the mock path.
