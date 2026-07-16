---
"@originals/landing": patch
---

Add Railway deploy config for the landing page (#330): `railway.json` builds the workspace (SDK + auth via turbo) then the Vite SPA, and `apps/landing/serve.ts` is a small Bun static server (SPA fallback, path-traversal guard, binds `0.0.0.0:$PORT`).
