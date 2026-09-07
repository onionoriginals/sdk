# Originals landing page

Marketing site for the Originals Protocol at `apps/landing/`. Vite + React +
TypeScript, with a live demo that runs the **real `@originals/sdk`** in the
browser — `createAsset → publishToWeb → inscribeOnBitcoin` against the SDK's
mock Ordinals provider, plus a genuine SDK-minted Original ("First Light")
that every visitor's browser re-verifies cryptographically.

Build log and grading protocol: [`PROGRESS.md`](./PROGRESS.md) ·
[`GRADING.md`](./GRADING.md). Deployment: [`DEPLOY.md`](./DEPLOY.md).

## Develop

```bash
bun install            # repo root
bun run build          # workspace packages (the app bundles the SDK's dist)
cd apps/landing
bunx vite              # dev server
```

One-liner from the root for a production build + preview: `bun run landing`.

## Scripts

| Command (from `apps/landing`) | What it does |
| ----------------------------- | ------------ |
| `bun run ci` | Full CI gate: build packages + app, serve dist, browser smoke test; fails on any console error. Root alias: `bun run landing:ci`. |
| `bun run smoke` | Smoke test only (against `http://localhost:4173`): full real-SDK lifecycle in headless Chromium, asserts zero console errors. |
| `bun run og` | Regenerate `public/og.png` (1200×630 share card) from the generative artwork + wordmark + tagline. Only needed when copy, the icon, or the artwork generator changes. |
| `bun run icons` | Regenerate `public/favicon.ico` + `public/apple-touch-icon.png` from the inline SVG icon in `index.html`. |
| `node scripts/shots.mjs` | 375/1440 screenshots. |
| `node scripts/tti.mjs` | Throttled time-to-interactive measurement. |
| `bun scripts/make-example.ts` | Re-mint the "First Light" example Original in `public/example/`. |
| `bun run dry-run:inscription` | Build and sign a commit + reveal pair through the shipped path and refuse to broadcast it (#526). With `QUICKNODE_ENDPOINT` + `BTC_NETWORK=mainnet` + `DRY_RUN_WIF` it reads mainnet and signs; without an endpoint it runs the mock provider. Prints both raw transactions, fees, inputs and a pass/fail checklist. |

Headless Chromium resolves via `scripts/browser.mjs`: `CHROMIUM_PATH` env →
`/opt/pw-browsers/chromium` → playwright-core's registry (`bunx
playwright-core install --with-deps chromium` on fresh machines; never the
full `playwright` package).

## House rules

- **All copy lives in `src/content.ts`** — one editable file. The
  title/description/URL meta in `index.html` are injected from it at build
  time (`%SITE_*%` tokens, see `vite.config.ts`).
- **`site.url` in `src/content.ts` is the single production-URL constant**
  (placeholder until issue #330 picks the domain). `public/robots.txt` and
  `public/sitemap.xml` must carry the same origin; the build fails if they
  drift.
- **Real, not canned**: the demo and the verified example call the actual
  SDK; nothing is faked.
- **Zero external runtime dependencies**: self-hosted fonts, no CDNs, no
  trackers — the page works with every third-party domain blocked.

## Analytics — decided: none

The page ships **no analytics** (issue #335). Keeping the
zero-external-runtime-dependency property was judged worth more than
pageview counts: no consent banner, nothing for extensions to block, no
third-party javascript on a page whose whole pitch is verifiability. If
demand appears later, prefer host-side/server-log analysis (Netlify
Analytics, Cloudflare Web Analytics in server mode) over client-side
scripts; any client-side option must be cookie-less and self-hosted.

## Deploy

See [`DEPLOY.md`](./DEPLOY.md) — exact build command + publish directory for
Vercel / Netlify / Cloudflare Pages / GitHub Pages, the CI gate
(`bun run landing:ci`), and the domain-swap checklist for when #330 lands.


### Completing inscriptions after a block

The server subscribes to Bitcoin block notifications over the
[mempool WebSocket protocol](https://mempool.space/docs/api/websocket).
Each new block wakes the bounded inscription completion sweep; QuickNode still
checks that each commit is confirmed before its persisted reveal is broadcast.
The feed receives only a blocks subscription, with no user addresses or transaction
IDs sent to it. It defaults to mempool.space on `BTC_NETWORK` (mainnet or testnet4).

Set `BTC_BLOCKS_WS_URL` to a mempool-compatible `wss://` endpoint to use your own
feed, or `off` to disable it. Connections reconnect automatically and run a catch-up
pass when restored. Startup and hourly passes remain as fallback. Concurrent triggers
are coalesced and serialized, and `INSCRIBE_SWEEP_MAX_PER_PASS` (default 25) still
bounds each pass. A backlog larger than that rotates fairly across subsequent
passes; block notifications do not bypass the confirmation check or per-pass cap.
Deposit-balance and stale-record monitoring retain their hourly cadence.

After deploying, watch `inscription_sweep_completed`, `inscription_sweep_waiting`
and `Bitcoin block feed unavailable` in server logs over the next two blocks.
Confirmed commits should advance to `reveal_broadcast` without a browser tab.
If the feed repeatedly fails, set `BTC_BLOCKS_WS_URL=off` while diagnosing it;
the hourly recovery path stays active. Public feed availability and QuickNode's
view of confirmation determine how quickly a received block can lead to completion.

### Public Explore collection

`/explore` lists active CEL 3 publications recorded by accounts on this host.
It spans accounts and needs no session. It is a catalogue of this app's durable
publications, not a network-wide Bitcoin index. `/explore/<encoded-did>` opens
a public detail page with the controller identity, hosted logs and primary file.

`GET /api/explore` accepts `q` (title or identity, up to 150 characters), `limit`
(1–48, default 24), and `offset` (default 0). Results sort by signed creation time,
newest first, then DID; the response contains `originals`, `total`, and
`nextOffset`. `GET /api/explore/original?did=…` returns a single entry or 404.
The catalogue caches for 15 seconds and each client IP gets 60 requests/minute.
New publications can therefore take up to 15 seconds to appear.

Account indexes supply candidate DIDs only. Discovery checks account ownership
of the hosted artifacts, the signed CEL history and both directions of the
WebVH identity binding. Account metadata and claimed Bitcoin status are omitted.
The existing public artifact URLs remain public; account listing and writes stay
authenticated. Discovery does not assert Bitcoin confirmation or sat possession.
Browser previews hash the resource bytes before rendering an image-only blob;
public detail independently verifies the hosted histories and primary file.

To exercise the collection without production credentials or Bitcoin funds:

```sh
bun run landing:check
bun apps/landing/scripts/explore-smoke.ts
```

The browser smoke creates 26 real signed publications in a temporary store,
serves the built app, checks search/pagination, image and text previews,
verification/tampering, retry and mobile layouts, then removes its data.
Set `EXPLORE_SCREENSHOTS` to a directory to save visual evidence.
