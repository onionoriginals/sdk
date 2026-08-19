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
| `ORIGINALS_DATA_DIR` | always | users' Originals **and signed reveal transactions** land on an ephemeral path and are wiped on the next redeploy |
| `TRUSTED_PROXY_HOPS` | behind a proxy | every visitor collapses into one shared rate-limit bucket |
| `CONFIG_STRICT` | opt-in | see below |

### Browser, baked at build time

`VITE_BTC_NETWORK` is compiled into the SPA by Vite. **Changing it at runtime
does nothing** — the value is already in the bundle. It must match
`BTC_NETWORK`, and changing it means a rebuild, not a restart. The server
compares the two at boot and the browser compares them again before any
real-money action; a mismatch is reported in both directions.

## Before enabling mainnet

Run one deploy with the code as-is and read the boot log. Do not proceed while
any of these is outstanding.

1. **Volume attached and mounted.** The log must not say the data directory is
   writable but not a mounted volume. Writability alone passes on exactly the
   ephemeral path this check exists to catch.
2. **Scheduled backup enabled.** Railway backups are opt-in and there is no
   published durability SLA. Record the schedule and who enabled it in the log
   at the bottom of this file — the setting is dashboard-only and cannot
   appear in a commit, so that line is the only evidence it happened.
3. **`TRUSTED_PROXY_HOPS` set** (Railway edge = `1`). Until it is, the
   per-client rate limits are inert and everyone shares one bucket. Confirm it
   from the `[landing] proxy sample:` line the server logs once per process:
   the resolved identity must be your address, not the proxy's.
4. **`QUICKNODE_ENDPOINT` reaches a mainnet node with the Ordinals & Runes
   add-on.** Without the add-on, sat lookup returns `SAT_INDEX_UNAVAILABLE`
   and inscription is impossible. `bun scripts/check-quicknode-ordinals.ts`
   is the pre-deploy probe.
5. **One live Turnkey OTP verification.** Still outstanding from PR #356, and
   now more important: the OTP login client signature was corrected in this
   branch after being found unacceptable to Turnkey's API, so the login path
   has almost certainly never completed end to end against a real org.
6. **One complete mainnet inscription by a human**, from a cold browser,
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
