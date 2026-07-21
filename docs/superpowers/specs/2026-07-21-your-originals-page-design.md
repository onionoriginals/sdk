# Your Originals — durable per-user did:webvh + a collection page

**Date:** 2026-07-21
**Status:** Approved design → implementation planning

## Problem

The landing demo creates **ephemeral** Originals (discarded on reset; the webvh
host store is TTL-expiring). A logged-in user has no durable collection and
nowhere to see "their Originals." Separately, the Inscribe (did:btco) step can't
do real testnet4 inscriptions (QuickNode's Ordinals add-on is mainnet-only, and
there's no hosted testnet4 sat-index), so it should stop pretending.

## Goal

1. A signed-in user's create→publish produces a **real, durable, resolvable
   did:webvh Original** owned by them (not ephemeral).
2. A **`/me` "Your Originals" page** lists their Originals (artwork, title,
   did:webvh with live "resolved ✓" + log link, created date).
3. The demo's **Inscribe step becomes "Coming soon"** — the demo is Create →
   Publish, both genuinely real. Track B code stays in-tree, gated.

## Decisions (locked)

| Question | Decision |
|---|---|
| Where Originals live | **Hosted did:webvh (server)** — real, resolvable, on-brand |
| Persistence backend | **Filesystem on a Railway volume** (no DB/new service) |
| How Originals are created | **Reuse the existing demo** create→publish; signed-in ⇒ it saves to the account |
| did:btco / inscribe | **"Coming soon"** (real inscription blocked on testnet4 ordinals) |

## Constraints discovered

- **No persistence exists.** No DB; the webvh host store (`server/webvh-host.ts`)
  is in-memory + TTL. The only user-tied thing is `createIdentity()` (a did:webvh
  in localStorage).
- **Single-page app, no router.** `App.tsx` renders sections; adding a "page"
  means introducing minimal client-side routing.
- **Auth already gives `subOrgId`** (JWT `sub`, via `extractToken`+`verifyToken`).
- **did:webvh hosting already works** (Track A): the SDK's `publishToWeb` routes
  hosting through a `StorageAdapter`; logs served at the resolver's exact URLs;
  the browser proves resolution with `resolveDID`.
- **Railway container FS is ephemeral** across restarts → durability requires a
  **mounted volume** (`ORIGINALS_DATA_DIR`).

## Architecture

```
 Browser (signed in)                      Unified Bun server (serve.ts / index.ts)
 ─────────────────────                    ────────────────────────────────────────
 DemoEngine.publish()                     PUT /api/originals/host/*  (auth) ─┐
   └─ DurableHostingAdapter ──PUT────────▶  → originalsStore.saveBytes(sub,…) │ durable
 after publish:                                                               │ filesystem
   POST /api/originals {did,title,…} ────▶ POST /api/originals (auth)         │ store
                                             → originalsStore.recordOriginal   │ (ORIGINALS_
 /me page:                                                                     │  DATA_DIR)
   GET /api/originals ───────────────────▶ GET /api/originals (auth)          │
                                             → originalsStore.list(sub)        │
 did:webvh resolver GET https://host/… ──▶ (buildFetch GET) hostStore.serve   │
                                             ?? originalsStore.serve(url) ◀────┘ durable serve
```

### Units

1. **`server/originals-store.ts`** (new) — durable, filesystem-backed.
   - `createOriginalsStore({ dataDir }): OriginalsStore`.
   - `saveBytes(subOrgId, key, bytes, contentType)` — write the did:webvh log /
     cel / resource bytes to disk under `${dataDir}/hosted/${key}` (key =
     `${domain}/${relativePath}`, same as the host adapter), **no TTL**. Also
     records the key under the user for ownership/cleanup.
   - `recordOriginal(subOrgId, { did, title, resourceHash, createdAt })` — append
     to the user's index `${dataDir}/users/${subOrgId}.json`.
   - `list(subOrgId): OriginalSummary[]`.
   - `serve(url): Response | null` — serve a hosted log/resource at the resolver
     URL (`${url.host}${url.pathname}`) from disk, with the same anti-XSS headers
     as the demo host store (`untrustedHeaders`). Durable (survives restart).
   - Path-traversal hardened (keys are validated; no `..`).

2. **Server routes** — mounted in `buildRoutes` / dispatched in `buildFetch`:
   - `PUT /api/originals/host/*` — **auth-gated** wildcard; stores durably under
     the JWT `sub`. (Dispatched in `buildFetch` like `/api/host/*`, but requires
     a valid session.)
   - `POST /api/originals` — auth-gated; `recordOriginal`.
   - `GET /api/originals` — auth-gated; returns the user's list.
   - `buildFetch` GET path: after the ephemeral `hostStore.serve`, fall through to
     `originalsStore.serve` so durable Originals resolve permanently.
   - Env-gated: the store activates when `ORIGINALS_DATA_DIR` is set (else a
     local `./.originals-data` dev default; the routes always mount when auth is
     configured).

3. **`src/sdk/durable-hosting-adapter.ts`** (browser, new) — a thin variant of
   `HttpHostingStorageAdapter` targeting `/api/originals/host/*` with
   `credentials: 'same-origin'` (sends the auth cookie).

4. **Engine save path** — `src/sdk/engine.ts` (or a small wrapper): when a
   `subOrgId` is present, `publish()` uses the durable adapter and, after
   resolution, the app POSTs `/api/originals` with `{ did, title, resourceHash }`.
   Anonymous users keep the current ephemeral `/api/host/*` path unchanged.

5. **`/me` page** — `src/pages/YourOriginals.tsx` (new): auth-gated; fetches
   `GET /api/originals`; renders each Original (artwork thumb, title, did:webvh
   with a live `resolveDID` "resolved ✓" + open-log link, created date). Empty
   state → "Create your first Original" → the demo.

6. **Routing** — `src/router.tsx` (new, minimal): `history`-based path switch
   between `/` (landing sections) and `/me` (Your Originals). Nav gains a "Your
   Originals" link shown only when signed in. No react-router dependency.

7. **Inscribe "Coming soon"** — `src/components/Demo.tsx` + `content.ts`: step 3
   renders a disabled **"Coming soon"** state (honest copy: real Bitcoin
   inscription is coming) instead of running the mock `inscribe()`. The demo
   completes at Publish. `btcTestnetEnabled()`-gated real path is untouched (so a
   future testnet4 ord source flips it back on).

## Data flow

**Create+save (signed in):** demo Create → Publish → `publishToWeb` hosts via
`DurableHostingAdapter` (`PUT /api/originals/host/*`, auth cookie) → server stores
bytes under `sub` → browser `resolveDID` proves it resolves → browser
`POST /api/originals {did,title,resourceHash}` records the summary.

**List:** `/me` → `GET /api/originals` → `originalsStore.list(sub)` → render;
each row re-resolves its did:webvh live.

**Resolve (anyone):** `GET https://<host>/<path>/did.jsonl` → `buildFetch` →
`hostStore.serve` (miss) → `originalsStore.serve` (durable hit).

## Security

- All `/api/originals*` routes are **auth-gated** (JWT cookie; 401 otherwise).
- `saveBytes` keys are namespaced + `..`-rejected; per-user index isolates
  ownership; a user can only list/record under their own `sub`.
- Durable `serve` uses the same anti-XSS headers (`nosniff` + sandbox CSP +
  attachment) as the demo store.
- Per-user quota (cap count + total bytes) to bound disk on a shared volume;
  per-IP + per-user rate limits on writes (reuse `rate-limit.ts`).

## Filesystem layout (under `ORIGINALS_DATA_DIR`)

```
hosted/<domain>/<path>/did.jsonl        # the served did:webvh log (durable)
hosted/<domain>/<path>/cel.json
hosted/<domain>/<path>/resources/<mb>
users/<subOrgId>.json                   # { originals: [ {did,title,resourceHash,createdAt,keys[]} ] }
```

## Deploy

- Attach a **Railway volume** mounted at e.g. `/data`; set `ORIGINALS_DATA_DIR=/data`.
- No new service, no DB. Dev falls back to `./.originals-data` (gitignored).

## Testing

- **Store units:** save→list roundtrip, durable serve at resolver URL, traversal
  rejection, per-user isolation, quota enforcement, restart durability (re-open
  the store on the same dir).
- **Routes:** auth-gating (401 anon), record/list under `sub`, PUT host durable.
- **Browser adapter:** `DurableHostingAdapter` PUTs to the right path with creds.
- **Engine integration:** signed-in publish → durable host + record, against an
  in-process store; anonymous publish still uses the ephemeral path.
- **UI:** `/me` renders a list + empty state (content/prop tests); Demo inscribe
  shows "Coming soon" and does NOT call `inscribe()`.
- **Routing:** `/` vs `/me` view switch.

## Out of scope

- did:btco / real inscription (blocked on testnet4 ordinals; stays gated).
- Cross-device sync beyond the server store; sharing/permissions; deletion UI
  (a `DELETE` can come later — store supports it, no UI yet).
- Migrating the ephemeral demo store to durable (kept separate: anonymous demo
  stays ephemeral).
