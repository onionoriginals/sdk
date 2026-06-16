# Plan 018: Harden email auth — CSPRNG session IDs, PII-free logs, server/client boundary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2b86eaa..HEAD -- packages/auth/src`
> If files under `packages/auth/src` changed since this plan was written,
> compare the "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (plan 017 touches a different file; either order works)
- **Category**: security
- **Planned at**: commit `2b86eaa`, 2026-06-11

## Why this matters

The email-OTP flow in `@originals/auth` has four hardening gaps:

1. **Session IDs come from `Math.random()`** — not a CSPRNG, and prefixed with
   `Date.now()`. Session IDs are bearer handles: `isSessionVerified(sessionId)`
   and `getSession(sessionId)` are exported (`src/server/index.ts:22-24`) for
   consuming servers to gate JWT issuance on. A predictable ID lets an attacker
   target someone else's in-flight session (brute-force the OTP against it) or,
   worse, claim a just-verified session if the consumer keys only on sessionId.
2. **PII and session secrets are logged** — emails, session IDs, and OTP IDs go
   to stdout via `console.log`, landing in whatever log aggregation exists.
3. **Server-grade code lives in the client module** — `src/client/turnkey-client.ts`
   imports `@turnkey/sdk-server` and reads `TURNKEY_API_PRIVATE_KEY` from env.
   A frontend importing `@originals/auth/client` pulls the server SDK into its
   bundle and normalizes reading the org's API private key in client code. A
   proper server-side `createTurnkeyClient` already exists at
   `src/server/turnkey-client.ts:21`.
4. **The default in-memory session store is silent about its limits** — sessions
   vanish on restart and don't share across instances; fine for dev, surprising
   in prod.

## Current state

All paths under `packages/auth/`:

- `src/server/email-auth.ts` — the OTP flow.
  - Session ID generation (lines 71–73):

    ```typescript
    function generateSessionId(): string {
      return `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    }
    ```

  - PII/secret logging: line 92 (`console.log(\`\n🚀 Initiating email auth for: ${email}\`)`),
    line 98 (email), line 120 (`OTP ID`), lines 132–136 (email + `Session ID:`),
    line 174 (sessionId), plus `console.error` at line 200 and similar sites
    later in the file (sweep the whole file).
  - In-memory storage factory `createInMemorySessionStorage` (lines 29–56) with
    a comment "For production, consider using Redis or a database"; the default
    storage is lazily created at lines 59–66.
  - Expiry is enforced at access time (`verifyEmailAuth` lines 160–164), so the
    60s cleanup interval is advisory — do NOT "fix" that; it's fine.
- `src/server/index.ts:22-24` — exports `isSessionVerified`, `getSession`.
- `src/client/turnkey-client.ts` — header comment says "Client-side Turnkey
  utilities / Uses @turnkey/sdk-server"; `initializeTurnkeyClient` (lines 49–75)
  reads `TURNKEY_API_PUBLIC_KEY` / `TURNKEY_API_PRIVATE_KEY` /
  `TURNKEY_ORGANIZATION_ID` from `process.env` and constructs a server
  `Turnkey` instance.
- `src/client/index.ts` — re-exports from `./turnkey-client` (check the exact
  export list when you edit).
- `src/server/turnkey-client.ts:21` — `createTurnkeyClient(config?)`: the
  server-side equivalent that should be the only env-reading constructor.
- Tests: `packages/auth/tests/email-auth.test.ts`, `client-turnkey.test.ts`,
  `turnkey-client.test.ts` — read them before editing; they pin current
  behavior including, possibly, the session-ID format and client exports.
- Baseline: `cd packages/auth && bun test` → 137 pass / 2 fail. The 2 failures
  are in `turnkey-signer.test.ts` and belong to plan 017 — they are NOT yours;
  do not let them grow.

## Commands you will need

| Purpose    | Command (from repo root)        | Expected on success |
|------------|----------------------------------|---------------------|
| Auth tests | `cd packages/auth && bun test`   | ≥137 pass; only the 2 plan-017 failures remain (0 if 017 landed first) |
| Secret-read grep | `grep -rn "TURNKEY_API_PRIVATE_KEY" packages/auth/src/client/` | no matches (after Step 3) |
| PII-log grep | `grep -rnE "console\.(log\|error).*(email\|sessionId\|Session ID\|otpId\|OTP ID)" packages/auth/src/server/email-auth.ts` | no matches (after Step 2) |

## Scope

**In scope**:
- `packages/auth/src/server/email-auth.ts`
- `packages/auth/src/client/turnkey-client.ts`
- `packages/auth/src/client/index.ts`
- `packages/auth/src/server/index.ts` (only if re-exporting moved symbols)
- `packages/auth/tests/email-auth.test.ts`, `packages/auth/tests/client-turnkey.test.ts`
  (update assertions that pin old behavior; add new cases)
- `packages/auth/README.md` or in-file JSDoc for the storage warning (whichever
  exists — check for a README in `packages/auth/`)
- `plans/README.md` (status row only)

**Out of scope**:
- `src/server/turnkey-signer.ts` — plan 017 owns it.
- `src/server/jwt.ts` and `src/server/middleware.ts` — verified separately;
  no changes here.
- Adding rate limiting — previously considered and rejected without deployment
  context (see `plans/README.md`, "Findings considered and rejected").
- Building a Redis/DB session store — document the need; don't build it.

## Git workflow

- Branch: `advisor/018-harden-email-auth`
- Conventional commits, e.g. `fix(auth): generate session IDs with CSPRNG`,
  `fix(auth): stop logging emails and session IDs`,
  `refactor(auth): remove server Turnkey initializer from client module`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: CSPRNG session IDs

In `src/server/email-auth.ts`, replace `generateSessionId` with:

```typescript
import { randomBytes } from 'node:crypto';

function generateSessionId(): string {
  return `session_${randomBytes(24).toString('base64url')}`;
}
```

(Keep the `session_` prefix — cheap greppability; drop the timestamp, it
leaked creation time and added no entropy.) Check
`tests/email-auth.test.ts` for assertions on the ID format and update them to
assert prefix + length ≥ 32 + uniqueness across two calls, rather than the old
shape.

**Verify**: `cd packages/auth && bun test tests/email-auth.test.ts` → all pass

### Step 2: Remove PII/secret logging

Sweep `src/server/email-auth.ts` for every `console.log`/`console.error` that
includes `email`, `sessionId`, or `otpId` (sites listed in "Current state";
sweep the whole file — there are more after line 200). For each: delete it, or
keep a redacted operational line (e.g. `console.log('[email-auth] OTP sent')`).
Never interpolate `email`, `sessionId`, or `otpId` into a log string. Keep
`console.error('❌ OTP verification failed:', error)` but drop any session
identifiers from it (the error object from Turnkey may be kept).

**Verify**:
`grep -rnE "console\.(log|error)" packages/auth/src/server/email-auth.ts`
→ remaining lines contain no `${email}`, `${sessionId}`, `${otpId}` (or the
`Session ID:` banner). Then `bun test tests/email-auth.test.ts` → all pass.

### Step 3: Move the server-grade initializer out of the client module

In `src/client/turnkey-client.ts`:

1. Delete `initializeTurnkeyClient` (lines 49–75). The server equivalent is
   `createTurnkeyClient` in `src/server/turnkey-client.ts:21`.
2. Check what else in `src/client/` calls it:
   `grep -rn "initializeTurnkeyClient" packages/auth/src packages/auth/tests`.
   Migrate internal callers to accept a `Turnkey` instance as a parameter
   (dependency injection) instead of self-initializing — the surrounding
   functions (`initOtp` at line 80, etc.) already take `turnkeyClient` as a
   param, so this should be small.
3. Update `src/client/index.ts` exports. If external consumers likely used it
   (it was exported), re-export nothing from client but add a deprecation
   shim ONLY if tests show it was part of the documented client API — check
   `packages/auth/tests/client-turnkey.test.ts` first; if tests pin it as a
   client export, keep a shim that throws with a message pointing to
   `createTurnkeyClient` from `@originals/auth/server`, and note the breaking
   change for the next release in the commit body.

**Verify**: `grep -rn "TURNKEY_API_PRIVATE_KEY" packages/auth/src/client/` →
no matches; `cd packages/auth && bun test` → no new failures.

### Step 4: Production warning for the default in-memory store

In `getDefaultSessionStorage` (email-auth.ts lines 61–66), when constructing
the default store and `process.env.NODE_ENV === 'production'`, emit one
`console.warn` (no PII):
`'[auth] Using in-memory session storage in production: sessions are lost on restart and not shared across instances. Pass a persistent SessionStorage.'`
Add the same caveat as JSDoc on `createInMemorySessionStorage` and (if
`packages/auth/README.md` exists) a short "Production deployment" note.

**Verify**: `cd packages/auth && bun test` → no new failures.

### Step 5: OTP input validation (small, last)

In `verifyEmailAuth` (email-auth.ts line 147), before calling Turnkey, reject
codes that are not 4–10 chars of `[A-Za-z0-9]` with
`throw new Error('Invalid verification code format')`. (The flow requests
`otpLength: 6, alphanumeric: false` at lines 110–111, but Turnkey config may
vary; validate loosely, just enough to stop garbage/oversized payloads.)
Add one test: a 5000-char code throws without hitting the Turnkey client mock.

**Verify**: `cd packages/auth && bun test` → all pass except (at most) the 2
pre-existing plan-017 failures.

## Test plan

- Update: session-ID format assertions in `tests/email-auth.test.ts` (Step 1).
- New: uniqueness + prefix test for `generateSessionId` (via two
  `initiateEmailAuth` calls with mocked Turnkey, comparing returned IDs);
  oversized-OTP rejection test (Step 5).
- Pattern to model: existing tests in `tests/email-auth.test.ts` (they already
  mock the Turnkey client).

## Done criteria

ALL must hold:

- [ ] `grep -rn "Math.random" packages/auth/src/` → no matches
- [ ] `grep -rn "TURNKEY_API_PRIVATE_KEY" packages/auth/src/client/` → no matches
- [ ] No `console.log`/`console.error` in `email-auth.ts` interpolates email,
      sessionId, or otpId
- [ ] `cd packages/auth && bun test` → 0 failures attributable to this plan
      (only plan-017's 2, if 017 hasn't landed)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- `tests/client-turnkey.test.ts` shows `initializeTurnkeyClient` is load-bearing
  client API used with *client-side* Turnkey credentials (not the org API
  private key) — then the right fix is renaming/documenting, not deleting, and
  the maintainer should choose.
- Any consuming code inside this monorepo (search `grep -rn "initializeTurnkeyClient" --include='*.ts' .`
  excluding node_modules/dist) depends on it from outside `packages/auth` —
  report the callers instead of editing files out of scope.
- Session-ID format is persisted/parsed anywhere (e.g. something splits on the
  `Date.now()` segment) — format change would corrupt it.

## Maintenance notes

- The deeper fix for sessions is a pluggable persistent store (Redis adapter)
  — explicitly deferred; the interface (`SessionStorage`) already supports it.
- Reviewer should scrutinize Step 3's export changes for semver impact on the
  published `@originals/auth` package: removing a client export is breaking;
  the commit body must say so.
- If/when an HTTP server in this repo consumes `isSessionVerified`, it must
  key on (sessionId AND email) or exchange the session for a one-time token at
  verification — note for the auth-server integration work.
