# Landing auth server

Standalone Bun server exercising `@originals/auth` 2.0 email-OTP auth for the landing page.

## Run

1. Build the auth package: `cd ../../packages/auth && bun run build`
2. Copy env: from `apps/landing/`, run `cp server/.env.example .env` and fill in real
   Turnkey creds + `JWT_SECRET`.

   > **Important — env file placement.** The `.env.example` template lives in
   > `apps/landing/server/`, but the `dev:server` script runs
   > `bun run --watch server/index.ts` from `apps/landing/`, and Bun auto-loads `.env`
   > from the current working directory. So the filled-in env file **must** sit at
   > `apps/landing/.env` (not `apps/landing/server/.env`) or your creds will be
   > silently ignored. Running `cp server/.env.example .env` from `apps/landing/`
   > puts it in the right place.
3. From `apps/landing/`: `bun run dev:all` (starts the Bun server on :8787 and Vite on :5173).

The Vite dev server proxies `/api` → `http://localhost:8787`, so the browser is same-origin.

## Manual E2E checklist (real Turnkey)

Requires live `TURNKEY_*` creds, `JWT_SECRET`, and access to the target inbox.

- [ ] Click **Sign in**, enter your email, **Send code** → 200, code arrives by email.
- [ ] Enter the 6-digit code → modal closes, nav shows your email (cookie set).
- [ ] Reload the page → still signed in (`GET /api/me` succeeds from the httpOnly cookie).
- [ ] Enter a wrong code 5× → session destroyed, must request a new code.
- [ ] Click **Create your did:webvh** → a `did:webvh:…` string appears.
- [ ] **Sign out** → nav returns to **Sign in**; reload stays signed out.

## Notes
- Session storage is in-memory (lost on restart; single process). Not for production.
- Rate limiting is in-memory (per IP + per email); also single-process.
