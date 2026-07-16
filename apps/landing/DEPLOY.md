# Deploying the landing page

The site is a fully static Vite build with **no server component, no
environment variables, no secrets, and zero external runtime dependencies**
(fonts self-hosted, demo runs the real `@originals/sdk` client-side against
its mock Ordinals provider). Any static host + CDN works. This documents the
exact settings per host (issue #330); the only open item is the hosting /
domain decision itself.

## The two settings every host needs

| Setting | Value |
| ------- | ----- |
| Build command | `bun install && bun run build && cd apps/landing && bunx vite build` |
| Publish directory | `apps/landing/dist` |

The `bun run build` step compiles the workspace packages (the app bundles
`@originals/sdk` from its dist); `vite build` then emits the site.

## CI gate (run before every deploy)

```bash
bun run landing:ci        # from the repo root
# = bun apps/landing/scripts/ci.mjs
```

Builds packages + app, serves the production bundle, and runs
`scripts/smoke.mjs` in headless Chromium: the full real-SDK lifecycle
(`did:peer → did:webvh → did:btco`) must complete with **zero console
errors or pageerrors**, else the script exits non-zero.

Chromium on a fresh runner: `bunx playwright-core install --with-deps
chromium` (version-matched to the pinned `playwright-core` devDependency),
or point `CHROMIUM_PATH` at an existing binary. Do not add the full
`playwright` package — `playwright-core` is already a devDependency and its
CLI installs browsers.

## Per-host settings

### Vercel

- Framework preset: **Vite** (or Other) · Root directory: repo root
- Install command: `bun install`
- Build command: `bun run build && cd apps/landing && bunx vite build`
- Output directory: `apps/landing/dist`
- Bun is available on Vercel builders by default; no `vercel.json` needed.

### Netlify

- Base directory: repo root · Publish directory: `apps/landing/dist`
- Build command: `bun install && bun run build && cd apps/landing && bunx vite build`
- Or commit a `netlify.toml` at the repo root:

  ```toml
  [build]
  command = "bun install && bun run build && cd apps/landing && bunx vite build"
  publish = "apps/landing/dist"
  ```

### Cloudflare Pages

- Build command: `bun install && bun run build && cd apps/landing && bunx vite build`
- Build output directory: `apps/landing/dist`
- Root directory: repo root (build system v2/v3 ships bun).

### GitHub Pages

No build settings — deploy from an Actions workflow: `oven-sh/setup-bun`,
run the build command above (plus `bun run landing:ci` as the gate, after
`bunx playwright-core install --with-deps chromium`), then
`actions/upload-pages-artifact` with `path: apps/landing/dist` and
`actions/deploy-pages`.

**Caveat:** a project page serves from `https://<org>.github.io/sdk/`, so
`vite build` needs `--base=/sdk/` (or a `base` entry in `vite.config.ts`)
unless a custom domain is attached at the root. The other three hosts serve
from `/` and need no change.

## When the domain is decided (the rest of #330)

1. Swap the placeholder in **`src/content.ts` → `site.url`** — the single
   production-URL constant. It is injected at build time into the canonical
   link, `og:url`, `og:image`, and `twitter:image`.
2. Update the matching absolute URLs in `public/robots.txt` and
   `public/sitemap.xml` — **the build fails with a pointed error if these
   drift from `site.url`**, so a half-swap cannot ship.
3. Rebuild and deploy. Nothing else references the domain.
