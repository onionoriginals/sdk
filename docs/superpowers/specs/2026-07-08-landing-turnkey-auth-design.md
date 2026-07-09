# Landing-page Turnkey email-OTP auth — design

**Date:** 2026-07-08
**Branch:** `claude/turnkey-auth-hardening-n83ch0`
**Status:** Approved design, ready for implementation plan

## Goal

Wire a real, end-to-end exercise of this branch's `@originals/auth` **2.0** hardening
into `apps/landing`, so the changes on this branch are validated against a live
Turnkey backend. The flow: email → OTP code → verified session (httpOnly JWT
cookie) → create a `did:webvh` with the Turnkey signer.

The changed surface this must exercise:
`packages/auth/src/server/email-auth.ts`, `server/turnkey-client.ts`, `server/jwt.ts`,
`server/middleware.ts`, and `client/server-auth.ts`.

## Strategy: port boop's proven logic, target the 2.0 API

boop (`github.com/aviarytech/todo`, local `~/Projects/aviarytech/poo-app`) already
runs this auth in production, but:

- Its backend is **Convex** (serverless functions + Convex DB session store + HTTP
  router). Pulling Convex into a plain Vite SPA is heavier, not lighter.
- It is pinned to **`@originals/auth@1.8.2`** — the flow *before* this branch's
  hardening. Specifically it (a) provisions the Turnkey sub-org at **initiate**
  time, and (b) does **no** browser P-256 `publicKey` binding on verify. Both are
  exactly what 2.0 changed.

Therefore we **do not** adopt Convex and **do not** copy boop's flow verbatim.
Instead we lift boop's *framework-agnostic* pieces (which solve every Turnkey
landmine) into a standalone Bun server and wire them against the 2.0 API.

Reused from boop (proven, portable):
- `getEd25519Account(subOrgId)` — confirms the **parent Turnkey API key signs for
  the sub-org**, does the wallet/account lookup, key derivation, and the
  `signingOrganizationId` selection.
- The `TurnkeyWebVHSigner` specifics: ed25519 sha512 configuration, signature
  length handling, `signRawPayload` response shape.
- The DID-creation core and JWT/cookie approach.
- The two-step client UX (`Login.tsx`, `OtpInput.tsx`).

Deltas from boop (so we test the *new* flow, not the old one):
- **Deferred provisioning** — sub-org is created in `verifyEmailAuth`, not at
  initiate.
- **Browser `publicKey` binding** — the client generates a P-256 keypair and
  passes its public key to verify, so the verification-token private key never
  transits HTTP.
- **`createDIDWithTurnkey`** (2.0, proper multibase Multikey) instead of boop's
  raw `didwebvh-ts` + address-as-multibase shortcut.

## Backend — `apps/landing/server/` (standalone `Bun.serve()`)

A single Bun server on port `8787`. Ports boop's `convex/http.ts` handlers to
plain fetch routes; session storage is `@originals/auth`'s
`createInMemorySessionStorage()` (dev/test-appropriate). One `createTurnkeyClient()`
singleton from env.

| Route | 2.0 wiring |
|---|---|
| `POST /api/auth/send-otp` | Rate-limit **per-IP and per-email** (README mandates), then `initiateEmailAuth(email, turnkey, store)` → `{ sessionId, message }`. No sub-org provisioned yet. |
| `POST /api/auth/verify-otp` | `verifyEmailAuth(sessionId, code, turnkey, store, { publicKey })` → provisions sub-org on success → `signToken(subOrgId, email)` → `Set-Cookie` httpOnly `auth_token` → `{ verified, email, subOrgId }`. |
| `GET /api/me` | `verifyToken(cookie)` → `{ subOrgId, email }`. Proves the session survives reload. |
| `POST /api/did/create` | Protected. `getEd25519Account(subOrgId)` → `TurnkeyWebVHSigner` → `createDIDWithTurnkey` → `{ did, didDocument, didLog }`. |
| `POST /api/auth/logout` | `getClearAuthCookieConfig` → clear cookie. |

Files (each one clear purpose, testable in isolation):
- `server/index.ts` — `Bun.serve` + tiny router + cookie parsing.
- `server/auth-routes.ts` — send-otp / verify-otp / me / logout handlers.
- `server/did-routes.ts` — `/api/did/create`.
- `server/turnkey.ts` — `createTurnkeyClient` singleton + `getEd25519Account`
  (ported from boop `turnkeyHelpers.ts`).
- `server/rate-limit.ts` — in-memory per-IP + per-email limiter.
- `server/.env.example`.

### Rate limiting
In-memory sliding window keyed by both client IP and normalized target email on
`/api/auth/send-otp` (and by `sessionId` on `/api/auth/verify-otp`, mirroring
boop). Sufficient for a single-process dev/test server; documented as
non-distributed.

## Client — `apps/landing/src/`

- `src/auth/useAuth.tsx` — React context + hook. Hydrates from `/api/me` on mount;
  exposes `login(email)` / `verify(code)` / `logout()` / `createIdentity()` and
  `{ user, isAuthenticated, isLoading }`.
- `src/auth/api.ts` — thin wrappers: `@originals/auth/client` `sendOtp`/`verifyOtp`
  (the latter generating a browser P-256 keypair via `generateP256KeyPair` from
  `@turnkey/crypto` and passing `publicKey`), plus `fetch` for `/api/me`,
  `/api/did/create`, `/api/auth/logout`.
- `src/components/LoginModal.tsx` (+ css) — two-step email → OTP UX, reshaped from
  boop's `Login.tsx` + `OtpInput.tsx` (react-router and analytics stripped).
- `Nav.tsx` — **Sign in** button opens the modal; when authenticated, shows the
  email, a **Create your did:webvh** button (calls `/api/did/create`, displays the
  resulting DID + JSON), and logout.

## Wiring / config

- **Vite dev proxy**: `server.proxy` maps `/api` → `http://localhost:8787`, so all
  browser calls are same-origin and the httpOnly cookie works without CORS.
- **Deps**: add `@originals/auth` (`workspace:*`) and `@turnkey/crypto` to
  `apps/landing`. `packages/auth` must be built to `dist/` first (its exports point
  at `dist`).
- **Scripts** (in `apps/landing/package.json`): `dev:server`
  (`bun run --watch server/index.ts`), keep `dev` (vite), add `dev:all` to run both.
- **Env** (`apps/landing/server/.env.example`, Bun auto-loads `.env`):
  `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`,
  `JWT_SECRET`, optional `TURNKEY_API_BASE_URL`, `WEBVH_DOMAIN`.

## Testing

- **Route-level tests** with an **injected mock Turnkey client** (following the
  existing `packages/auth/tests/turnkey-did-creation.integration.test.ts` pattern
  of a Turnkey-shaped `signRawPayload` mock): send-otp rate-limit rejection;
  verify-otp deferred provisioning + cookie issuance; `/api/me` auth gate;
  `/api/did/create` wiring producing a valid `did:`.
- **Manual real-Turnkey E2E checklist** (documented in `apps/landing/server/README`
  or the app README): requires live `TURNKEY_*` creds + `JWT_SECRET` + a real
  inbox; walks send → receive email → verify → reload persists → create DID.
  Not automated (needs credentials and email delivery).

## Phasing

1. **Server + OTP + JWT + login modal.** Fully tests every file this branch
   changed. Ships independently.
2. **`/api/did/create` + UI.** The identity story. The Turnkey signer itself was
   *not* changed on this branch, so this is additive; boop-derived and de-risked.

## Risks

- **`@turnkey/crypto` browser compatibility** with the landing's existing Node-shim
  aliases (`node:crypto` → `src/shims/crypto.ts`, etc. in `vite.config.ts`).
  Verified early in Phase 1; if `generateP256KeyPair` needs a real primitive the
  shim lacks, extend the shim or generate the keypair via WebCrypto.
- **Turnkey signing authority** (parent key signs for a freshly-provisioned,
  credential-less sub-org). **Resolved** — boop does exactly this in production.

## Decisions locked

- Server lives at `apps/landing/server/` (not a separate workspace package).
- Real-Turnkey E2E stays a documented manual checklist, not automated.
