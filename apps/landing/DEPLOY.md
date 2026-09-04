# Deploying the landing page

The site is a **long-lived Bun server**, not a static bundle. It holds a
mounted volume, needs secrets, and talks to Turnkey and a Bitcoin node. A
static host cannot run it.

That matters more than it sounds: the volume is the entire database — there is
no Postgres, SQLite or Redis anywhere in this app — and it holds the only
copies of signed-but-unbroadcast Bitcoin transactions. Deploying this as a
static publish directory drops the server, and after the creator-pays
inscription path is live it strands real money.

## What the deploy actually is

| Setting | Value |
| ------- | ----- |
| Build command | `bun install && bun run build && cd apps/landing && bun run build` |
| Start command | `bun run apps/landing/serve.ts` |
| Persistent volume | required, mounted, with `ORIGINALS_DATA_DIR` pointing at it |

`/railway.json` at the repo root carries the build and start commands. It does
**not** declare the volume or any environment variable — those are dashboard
state, so the checklist below is the only place they are written down.

## Environment contract

`apps/landing/server/config.ts` validates this at boot and reports every
violation by name. It is **warn-only** unless `CONFIG_STRICT=1`. See
"Turning on strict mode" before you set that flag.

### Server, read at runtime

| Variable | Required when | Missing behaviour |
| --- | --- | --- |
| `NODE_ENV=production` | always, on a deploy | auth cookie loses `Secure` |
| `JWT_SECRET` (≥32 chars) | always | auth API silently unmounts; a short value makes every login fail with a generic message |
| `TURNKEY_API_PUBLIC_KEY` | always | auth API silently unmounts |
| `TURNKEY_API_PRIVATE_KEY` | always | ” |
| `TURNKEY_ORGANIZATION_ID` | always | ” |
| `BTC_NETWORK` | always | silently inherits the `testnet4` default |
| `QUICKNODE_ENDPOINT` | `BTC_NETWORK=mainnet` | real inscription silently stays mock |
| `BTC_INDEXER_API` | never (has a default) | deposit reads run against the **free public** mempool.space API — unauthenticated, rate-limited at their discretion. Warned at boot on a mainnet deploy; never an error, because shipping on the free tier is the sanctioned choice (KTD4) |
| `BTC_INDEXER_TOKEN` | with a paid/private `BTC_INDEXER_API` | the read goes out unauthenticated and the paid tier rejects or throttles it |
| `BTC_INDEXER_AUTH_HEADER` | when the index wants something other than `Authorization: Bearer` | token is sent as a bearer token |
| `ORIGINALS_DATA_DIR` | always | users' Originals **and signed reveal transactions** land on an ephemeral path and are wiped on the next redeploy |
| `TRUSTED_PROXY_HOPS` | behind a proxy | every visitor collapses into one shared rate-limit bucket |
| `CONFIG_STRICT` | opt-in | see below |

### Browser, baked at build time

`VITE_BTC_NETWORK` is compiled into the SPA by Vite. **Changing it at runtime
does nothing** — the value is already in the bundle. It must match
`BTC_NETWORK`, and changing it means a rebuild, not a restart. The server
compares the two at boot and the browser compares them again before any
real-money action; a mismatch is reported in both directions.

`VITE_WEBVH_HOST` is the same shape of value and the more permanent one. It is
the single host every `did:webvh` identifier this site publishes will name,
**forever** — a did:webvh domain cannot be changed after publication. Unset, the
SPA falls back to `window.location.host`, so a visitor who arrives on the
Railway-generated `*.up.railway.app` hostname mints DIDs pinned to it. Set it to
the canonical domain (`originals.build`) as a **bare hostname** — no scheme, no
port, no path. Required on a mainnet deploy and reported by name at boot; the
server also reads it at runtime and 301s document requests from any other host,
so the redirect and the DID cannot disagree. `/api/*` is exempt from that
redirect, so publishing writes and platform probes are unaffected.

## Before enabling mainnet

Run one deploy with the code as-is and read the boot log. Do not proceed while
any of these is outstanding.

1. **`VITE_WEBVH_HOST` set to the canonical domain, and the SPA rebuilt with
   it.** The boot log names it if it is missing. Verify it reached the bundle,
   not just the dashboard: `curl -s https://<host>/assets/engine-*.js | grep -o
   'VITE_WEBVH_HOST:`[^`]*`'` — Vite deletes the branch entirely when the value
   is absent at build time, so an unset var leaves no trace to grep for and the
   only evidence is the value being present.
2. **Volume attached and mounted.** The log must not say the data directory is
   writable but not a mounted volume. Writability alone passes on exactly the
   ephemeral path this check exists to catch.
3. **Scheduled backup enabled.** Railway backups are opt-in and there is no
   published durability SLA. Record the schedule and who enabled it in the log
   at the bottom of this file — the setting is dashboard-only and cannot
   appear in a commit, so that line is the only evidence it happened.
4. **`TRUSTED_PROXY_HOPS` set** (Railway edge = `1`). Until it is, the
   per-client rate limits are inert and everyone shares one bucket. Confirm it
   from the `[landing] proxy sample:` line the server logs once per process:
   the resolved identity must be your address, not the proxy's.
5. **`QUICKNODE_ENDPOINT` reaches a mainnet node with the Ordinals & Runes
   add-on.** Without the add-on, sat lookup returns `SAT_INDEX_UNAVAILABLE`
   and inscription is impossible. `bun scripts/check:ordinals` — i.e.
   `bun scripts/check-quicknode-ordinals.ts` — is the pre-deploy probe; it
   also exercises the deposit indexer seam when given an address
   (`BTC_CHECK_ADDRESS`) and can probe the add-on alone from any confirmed
   mainnet outpoint (`BTC_CHECK_OUTPOINT=txid:vout`).
   Note the two reads are **separate vendors on purpose**: QuickNode has no
   address→UTXO surface (Core there has no address index, `scantxoutset` is
   blocked at the edge, and the Ordinals add-on maps outpoint→address and
   sat→address only), so deposit polling costs no QuickNode quota and lives
   behind `BTC_INDEXER_API` instead.
   Then dry-run the inscription itself against those same reads, with zero
   money at risk (#526): `BTC_NETWORK=mainnet QUICKNODE_ENDPOINT=…
   DRY_RUN_ADDRESS=<funded bc1q…> DRY_RUN_WIF=<its key> bun run
   dry-run:inscription` builds and signs the commit and reveal through the
   real lifecycle against a provider that refuses to broadcast, prints both
   raw transactions, the live fee and the 1.5x quote, every input with its
   ordinal classification, the reveal key derivation and where the sat lands,
   and ends in a PASS/FAIL checklist. Keep the output with the deploy log.
6. **One live Turnkey OTP verification.** Outstanding since PR #356. This
   check earned its place twice over: the login path was broken the entire time
   it went unrun, in two independent ways, and neither was reachable from any
   test. It first sent a DER signature where OTP_LOGIN wants raw IEEE-P1363
   (both are plain hex strings, so nothing local could tell them apart), and
   underneath that it called the wrong activity entirely — an ordinary stamp on
   `otp_login`, which Turnkey answers with `PUBLIC_KEY_NOT_FOUND` because the
   credential being installed cannot already exist. It now runs STAMP_LOGIN
   with the attested stamp, which is what `@turnkey/core` does. The only thing
   that proves it works is running it against a real org.
7. **One complete mainnet inscription by a human**, from a cold browser,
   before anyone else is invited.

## Turning on strict mode

`CONFIG_STRICT=1` turns every contract violation into a refusal to start.
`/railway.json` caps restarts at 5, so flipping it against an environment that
does not satisfy the contract takes the site down rather than degrading it.

Deploy warn-only first, read the boot log, and fix everything it names —
`NODE_ENV` and `TRUSTED_PROXY_HOPS` in particular are ones Railway does not
set for you. Only when the final line reads `config contract: clean` should
you set the flag.

**Rollback is unsetting `CONFIG_STRICT` and restarting.** No redeploy, no
revert.

## Runbook: a stuck inscription

The commit and reveal are both signed and persisted before either is
broadcast, so a dead browser tab cannot strand funds on its own. Recovery runs
automatically on the `/me` list poll: a superseded pair whose commit actually
won is reinstated, a pair stuck at `commit_broadcast` completes once its commit
confirms, and a reveal still unconfirmed after 30 minutes is re-pushed from the
persisted copy.

**When the reveal is wedged by fees, rebroadcast and wait is the whole
remedy.** Replace-by-fee is impossible — the reveal's key is ephemeral by
design, so there is no way to re-sign a replacement. Child-pays-for-parent is
*also* not available to the operator: the postage output pays the user's own
address, whose key lives only inside that user's Turnkey session. Nobody
holding this runbook can build that transaction. If a real CPFP path is
wanted, it is a feature, not a runbook step.

An hourly sweep logs any inscription older than 24 hours still holding
un-landed recovery artifacts. That log line is the alert; there is no alerting
stack by design.

## Money-path logging and the deposit-balance sweep

Every state transition where a stranger's BTC moves or gets stuck emits one
line, prefixed `[landing][money] ` and followed by JSON. Grep that prefix.

| `event` | Emitted when |
| --- | --- |
| `deposit_address_issued` | An address is bound to an account for the first time |
| `deposit_seen` | A confirmed balance appears at a bound address |
| `deposit_shortfall` | The balance changed and still does not cover the quote |
| `deposit_read_failed` | An address read, or the address binding, could not be trusted |
| `deposit_ordinal_check_unavailable` | Outputs could not be classified, so none were offered as spendable |
| `inscribe_attempted` | A signed pair passed validation and is about to broadcast |
| `inscribe_failed` | A pair was refused or failed to broadcast (`reason` says which) |
| `inscribe_broadcast` | A pair reached the network |
| `deposit_balance_held` | A bound address still holds confirmed sats (per address) |
| `deposit_balance_sweep` | The hourly roll-up, including `withBalance` and `heldSats` |

**Users are identified by Turnkey sub-org id only.** These lines link an
account to on-chain activity and land in a third-party log sink, so an email
address is redacted by the formatter even if a call site passes one.

**`deposit_balance_sweep` is the only instrument that sees a stranger's funds
sitting unspent at an address nobody is polling.** `withBalance` going up and
staying up is the signal to look. Its read budget:

- **Cadence:** hourly, on the same timer as the stale-inscription sweep above.
  There is no second timer.
- **Ceiling:** 50 indexer reads per pass (`DEPOSIT_SWEEP_MAX_PER_PASS`), taken
  from a rotating cursor over a stably ordered list, so a backlog larger than
  one pass is covered across successive passes rather than starving behind the
  same head addresses.
- **Drop-out:** an address leaves the scan once it has nothing in flight, its
  last trusted read was zero confirmed sats, and that read is over 24h old.
  Without that the scan would grow with all-time signups. An address holding a
  balance never drops out — each pass re-reads it and records the read.
- **Known gap:** a deposit that first arrives more than 24h after its address
  went quiet is not seen by the sweep. The creator's own poll still sees it.

## Runbook: turning the money path off

Conditions that should trigger it:

- a stranded inscription the automatic passes cannot clear;
- a QuickNode or Turnkey outage;
- a volume-mount failure after a redeploy.

**Mechanism:** set `BTC_NETWORK` to `testnet4` (or unset `QUICKNODE_ENDPOINT`)
and restart. The `/api/btc/*` routes stop serving the mainnet path.

**What this does not do:** it does not reach users who already hold a confirmed
deposit. Their balance stays at an address derived from their own Turnkey
account, reachable only through this app's inscribe flow — so switching off
strands anyone mid-flow until it is switched back on. Before flipping it,
check the sweep log for pending inscriptions, and expect to tell those users
directly. There is no withdrawal path.

## Local development

```bash
bun install            # repo root
bun run build          # workspace packages
cd apps/landing
bun run dev:all        # vite + the API server
```

With nothing configured the server still starts and serves the SPA; the auth
and Bitcoin surfaces stay unmounted and the demo runs against the mock
Ordinals provider. The boot log names what is missing.

## CI gate

```bash
bun run landing:ci        # from the repo root
```

Builds the packages and the app, serves the **built static bundle** under
`vite preview`, and drives it headless asserting zero console errors and a
throttled time-to-interactive under 3s.

Two things to know about it:

- It exercises the **anonymous mock path only**. There is no server and no
  secret involved, so the signed-in mainnet path has no automated gate at all
  — it is covered solely by the manual checks above.
- **It is currently red on `main`**, independently of any change in this
  branch: `scripts/ci.mjs` proxies `/api/host/*` to `localhost:8787` without
  starting a server, so the smoke publish 502s. Fix that before treating this
  as a deploy gate; a gate that is red on arrival gets ignored.

Chromium on a fresh runner: `bunx playwright-core install --with-deps
chromium`, or point `CHROMIUM_PATH` at an existing binary. Do not add the full
`playwright` package.

## Production URL

`src/content.ts` → `site.url` is the single production-URL constant, injected
at build time into the canonical link, `og:url`, `og:image` and
`twitter:image`. `public/robots.txt` and `public/sitemap.xml` must carry the
same origin — the build fails with a pointed error if they drift, so a
half-swap cannot ship.

Changing it does **not** change any already-minted DID: asset DIDs are
published against the request host, and identity DIDs carry their own
hardcoded domain. Changing *that* would re-mint every existing user's
identity, which is why it is deliberately untouched.

## Volume backup log

Record each change here. This is the only durable evidence, since the setting
lives in the Railway dashboard.

| Date | Schedule | Enabled by |
| --- | --- | --- |
| _(not yet enabled — see "Before enabling mainnet" item 2)_ | | |
