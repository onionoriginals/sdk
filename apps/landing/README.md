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
