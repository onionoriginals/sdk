---
"@originals/landing": patch
---

Landing production server (`apps/landing/serve.ts`) now serves the SPA **and** mounts the `/api` auth routes in the same process when Turnkey env (`TURNKEY_*` + `JWT_SECRET`) is set, so the Railway deploy supports Sign-in same-origin. Without that env it serves static only and `/api/*` returns a clear JSON 404 instead of SPA-falling-back to `index.html` (which made the client parse HTML as JSON — "Unexpected token '<'").
