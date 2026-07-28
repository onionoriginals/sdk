# @originals/landing

## 0.1.2

### Patch Changes

- Updated dependencies [99dfa90]
  - @originals/sdk@2.1.0

## 0.1.1

### Patch Changes

- 76d0116: Warn loudly at boot when durable Originals will not persist. On a deployed instance (Railway markers / `NODE_ENV=production`) with the auth API enabled but `ORIGINALS_DATA_DIR` unset, the server now logs the resolved durable dir and a prominent warning that signed-in users' Originals are being written to an ephemeral container path and will be lost on redeploy. Warn-not-throw: the anonymous demo and Track-A did:webvh hosting still run without durable storage.
- 1e9c77f: Add Railway deploy config for the landing page (#330): `railway.json` builds the workspace (SDK + auth via turbo) then the Vite SPA, and `apps/landing/serve.ts` is a small Bun static server (SPA fallback, path-traversal guard, binds `0.0.0.0:$PORT`).
- 7384c60: Landing production server (`apps/landing/serve.ts`) now serves the SPA **and** mounts the `/api` auth routes in the same process when Turnkey env (`TURNKEY_*` + `JWT_SECRET`) is set, so the Railway deploy supports Sign-in same-origin. Without that env it serves static only and `/api/*` returns a clear JSON 404 instead of SPA-falling-back to `index.html` (which made the client parse HTML as JSON — "Unexpected token '<'").
- c579e07: Fix header nav links being dead on the `/me` (Your Originals) route. The nav renders on every route, but its in-page section anchors (`#why`, `#demo`, `#protocol`, `#developers`, and the wordmark's `#top`) had no target when those sections weren't mounted — so on `/me` only the JS-driven buttons (Sign out, Your Originals) responded. A shared `goToSection()` now routes home first when off `/`, then smooth-scrolls to the section once it mounts (and smooth-scrolls in place when already on `/`).
- e78c309: Harden the durable Originals host routes (issues surfaced by review of #431's merged code):

  - **Namespace pre-squat blocked.** `hostPut` now rejects a write to a `user-<slug>` path segment that isn't the caller's own, so an authenticated user can no longer claim another user's predictable publisher DID path (`user-<victim>/did.jsonl`) before them and lock them out. Asset paths are hash-derived (not `user-`-prefixed) and remain guarded by the store's first-writer-wins owner sidecar. The `webvh.ts` doc now describes the enforcement accurately.
  - **Malformed URL → 400, not 500.** A crafted percent-encoding (`%GG`) made `decodeURIComponent` throw an uncaught `URIError` (500). Both `hostPut` and `hostGet` now decode via a guarded helper and return a clean 400.
  - Removed a stray empty changeset (`red-dots-grab.md`).

- 75cfba7: Fix a production outage where every request to `originals.build/` (pathname `/`) returned 500 with `EISDIR: illegal operation on a directory, read`. The durable Originals `serve()`/`read()` mapped a directory-resolving key (e.g. `<host>/` for `/`, which exists once anything is hosted) through `readFileSync`, throwing `EISDIR` and crashing the request instead of falling through to the SPA. Both now guard with `statSync(path).isFile()` inside a try/catch (also closing the `existsSync`→`stat` TOCTOU), so a directory or vanished key is a clean miss/404.
- Updated dependencies [9d3c682]
- Updated dependencies [6ef2c47]
- Updated dependencies [cf78590]
- Updated dependencies [c23eeef]
- Updated dependencies [fca65b5]
- Updated dependencies [d5ebec2]
- Updated dependencies [db8beba]
- Updated dependencies [db8beba]
- Updated dependencies [fbaf69a]
- Updated dependencies [6bb75c1]
- Updated dependencies [784d0ea]
- Updated dependencies [37e8730]
- Updated dependencies [d0d88e9]
- Updated dependencies [06490bb]
- Updated dependencies [8f73929]
- Updated dependencies [e845cb7]
- Updated dependencies [49cf1d5]
- Updated dependencies [0e6674a]
- Updated dependencies [73eac12]
- Updated dependencies [e236aee]
- Updated dependencies [b1c05f0]
- Updated dependencies [15faa98]
- Updated dependencies [20df4be]
- Updated dependencies [7d02dc8]
- Updated dependencies [a07ff36]
- Updated dependencies [dbe3f10]
- Updated dependencies [0e6674a]
- Updated dependencies [dbe3f10]
- Updated dependencies [9e61052]
- Updated dependencies [122139b]
- Updated dependencies [a4e440f]
- Updated dependencies [9dddc24]
- Updated dependencies [e571787]
- Updated dependencies [ae15309]
- Updated dependencies [06644c5]
- Updated dependencies [a546db1]
- Updated dependencies [2443dc2]
- Updated dependencies [88d6eac]
- Updated dependencies [5981ec2]
- Updated dependencies [cb16f02]
- Updated dependencies [be4c5b6]
- Updated dependencies [f10e112]
- Updated dependencies [a546db1]
- Updated dependencies [7f4c42d]
  - @originals/sdk@2.0.0
  - @originals/auth@2.0.0
