---
"@originals/landing": patch
---

Add Railway deploy for the landing page (#330). `railway.json` builds the workspace (SDK + auth via turbo) then the Vite SPA; `apps/landing/serve.ts` is a single Bun service that serves the static SPA and — when Turnkey auth env (`TURNKEY_*` + `JWT_SECRET`) is set — also mounts the `/api` auth routes in-process so Sign-in works same-origin. Without that env it serves static only and `/api/*` returns a clear JSON 404 (not an SPA HTML page). SPA fallback + path-traversal guard, binds `0.0.0.0:$PORT`.
