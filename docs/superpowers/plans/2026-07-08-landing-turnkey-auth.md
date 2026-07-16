# Landing-page Turnkey email-OTP auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a working email-OTP login (and `did:webvh` creation) to `apps/landing`, backed by a standalone Bun server wired to `@originals/auth` 2.0, so this branch's auth hardening is exercised end-to-end against live Turnkey.

**Architecture:** A standalone `Bun.serve()` server in `apps/landing/server/` exposes `/api/auth/*` + `/api/me` + `/api/did/create`, calling `@originals/auth/server` (`initiateEmailAuth`, `verifyEmailAuth`, `signToken`, `verifyToken`) with an in-memory session store. Route handlers are factory functions that take an injected Turnkey client + session store, so they unit-test against a mock Turnkey (same `signRawPayload`-shaped mock as the existing integration test). The Vite dev server proxies `/api` to the Bun server so the browser is same-origin (httpOnly cookie, no CORS). The React client generates a browser P-256 keypair and passes its public key to verify, exercising the 2.0 token-binding hardening. Cookie parsing, `getEd25519Account`, and the OTP UI are ported from boop (`~/Projects/aviarytech/poo-app`).

**Tech Stack:** Bun, TypeScript, React 18, Vite 6, `@originals/auth` 2.0 (workspace), `@turnkey/crypto`, `@turnkey/sdk-server`, `didwebvh-ts`.

## Global Constraints

- **Auth package version:** target `@originals/auth` **2.0** (this branch). Do NOT reproduce boop's 1.8.2 flow (no initiate-time provisioning; no unbound verify).
- **Deferred provisioning:** the Turnkey sub-org is created only in `verifyEmailAuth`, never at send-otp.
- **publicKey binding:** the browser generates the P-256 keypair (`generateP256KeyPair` from `@turnkey/crypto`); its public key is passed to `verifyOtp`/`verifyEmailAuth` so no private key transits HTTP.
- **Rate limiting is mandatory** on send-otp — per client IP **and** per normalized target email (README requirement).
- **Import client code from `@originals/auth/client`, server code from `@originals/auth/server`** — never the package root in the browser bundle.
- **Server port:** `8787`. Vite dev proxy maps `/api` → `http://localhost:8787`.
- **Env vars:** `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`, `JWT_SECRET`, optional `TURNKEY_API_BASE_URL`, `WEBVH_DOMAIN`.
- **Commit style:** conventional commits. The repo's husky/commitlint hook currently fails to find its binary in this environment — commit with `--no-verify`.
- **Code comments:** one line where possible, non-obvious "why" only.
- **Build prerequisite:** `packages/auth` must be built to `dist/` (`cd packages/auth && bun run build`) before the landing server or typecheck can resolve `@originals/auth/*`.
- **Tests run with `bun test`** from `apps/landing/`. Server/logic tests only (no DOM); client UI is covered by typecheck + the manual E2E checklist.

---

## File Structure

Backend — `apps/landing/server/`:
- `index.ts` — `Bun.serve` entry: env load, build Turnkey client + session store, mount router, listen on 8787.
- `router.ts` — method+path dispatch, JSON helpers, CORS-free (same-origin via proxy).
- `cookies.ts` — `parseCookies`, `extractToken`, `serializeCookie` (ported from boop `convex/lib/jwt.ts`).
- `rate-limit.ts` — in-memory sliding-window limiter keyed by arbitrary string.
- `turnkey.ts` — `getTurnkey()` singleton; `getEd25519Account(turnkey, subOrgId)` (ported from boop `turnkeyHelpers.ts`).
- `auth-routes.ts` — `createAuthRoutes({ turnkey, sessions })` → `{ sendOtp, verifyOtp, me, logout }` handlers.
- `did-routes.ts` — `createDidRoutes({ turnkey, sessions })` → `{ createDid }` handler.
- `.env.example`.
- `README.md` — run instructions + manual E2E checklist.
- `tests/*.test.ts` — unit tests.

Client — `apps/landing/src/`:
- `auth/api.ts` — network layer: `sendOtp`, `verifyOtp` (with P-256 keypair), `fetchMe`, `createDid`, `logout`.
- `auth/useAuth.tsx` — `AuthProvider` + `useAuth()` context.
- `components/OtpInput.tsx` (+ `otp-input.css`) — 6-digit input (ported from boop).
- `components/LoginModal.tsx` (+ `login-modal.css`) — email→OTP modal (reshaped from boop `Login.tsx`).
- `components/Nav.tsx` — modified: Sign in button + authed state.
- `main.tsx` — modified: wrap `<App/>` in `<AuthProvider>`.

Config:
- `apps/landing/package.json` — add deps + `dev:server`/`dev:all` scripts.
- `apps/landing/vite.config.ts` — add `server.proxy`.

---

## PHASE 1 — Server + OTP + JWT + login modal

This phase alone exercises every file this branch changed.

---

### Task 1: Landing deps + build auth package + server skeleton with health route

**Files:**
- Modify: `apps/landing/package.json`
- Create: `apps/landing/server/router.ts`
- Create: `apps/landing/server/index.ts`
- Test: `apps/landing/server/tests/router.test.ts`

**Interfaces:**
- Produces: `router.ts` exports `json(data, status?, headers?)` → `Response`; `type Handler = (req: Request, url: URL) => Promise<Response> | Response`; `route(req, routes)` where `routes: Record<string, Handler>` keyed by `"METHOD /path"`, returning a 404 `Response` when unmatched.

- [ ] **Step 1: Add dependencies and scripts to `apps/landing/package.json`**

Add to `"dependencies"`: `"@originals/auth": "workspace:*"`, `"@turnkey/crypto": "^2.10.0"`. Add to `"scripts"`: `"dev:server": "bun run --watch server/index.ts"`, `"dev:all": "bun run dev:server & bun run dev"`, `"test": "bun test"`.

- [ ] **Step 2: Build the auth package so its `dist/` resolves**

Run: `cd packages/auth && bun run build && cd ../../apps/landing && bun install`
Expected: auth `dist/` populated; `bun install` links `@originals/auth` workspace.

- [ ] **Step 3: Write the failing test for the router**

Create `apps/landing/server/tests/router.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { json, route, type Handler } from '../router';

describe('router', () => {
  test('json() sets content-type and status', async () => {
    const res = json({ ok: true }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  test('route() dispatches on METHOD + path', async () => {
    const routes: Record<string, Handler> = {
      'GET /api/health': () => json({ status: 'ok' }),
    };
    const req = new Request('http://x/api/health', { method: 'GET' });
    const res = await route(req, routes);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('route() returns 404 when unmatched', async () => {
    const req = new Request('http://x/nope', { method: 'GET' });
    const res = await route(req, {});
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/router.test.ts`
Expected: FAIL — cannot find module `../router`.

- [ ] **Step 5: Implement `apps/landing/server/router.ts`**

```typescript
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export type Handler = (req: Request, url: URL) => Promise<Response> | Response;

export async function route(req: Request, routes: Record<string, Handler>): Promise<Response> {
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return json({ error: 'Not found' }, 404);
  return handler(req, url);
}
```

- [ ] **Step 6: Implement `apps/landing/server/index.ts` (health only for now)**

```typescript
import { json, route } from './router';

const PORT = Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    return route(req, {
      'GET /api/health': () => json({ status: 'ok' }),
    });
  },
});

console.log(`[auth-server] listening on http://localhost:${server.port}`);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd apps/landing && bun test server/tests/router.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/landing/package.json apps/landing/server/router.ts apps/landing/server/index.ts apps/landing/server/tests/router.test.ts
git commit --no-verify -m "feat(landing): auth server skeleton + router"
```

---

### Task 2: Cookie helpers (ported from boop)

**Files:**
- Create: `apps/landing/server/cookies.ts`
- Test: `apps/landing/server/tests/cookies.test.ts`
- Reference: `~/Projects/aviarytech/poo-app/convex/lib/jwt.ts` (`extractTokenFromRequest`, `parseCookies`)

**Interfaces:**
- Produces: `parseCookies(header: string): Record<string,string>`; `extractToken(req: Request, cookieName?: string): string | null` (checks `Authorization: Bearer`, then cookie; default cookie name `auth_token`); `serializeCookie(cfg: { name: string; value: string; options: { httpOnly?: boolean; secure?: boolean; sameSite?: 'strict'|'lax'|'none'; maxAge?: number; path?: string } }): string`.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/server/tests/cookies.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { parseCookies, extractToken, serializeCookie } from '../cookies';

describe('cookies', () => {
  test('parseCookies splits pairs and keeps = in values', () => {
    expect(parseCookies('auth_token=ab.cd=ef; other=1')).toEqual({
      auth_token: 'ab.cd=ef',
      other: '1',
    });
  });

  test('extractToken prefers Authorization Bearer', () => {
    const req = new Request('http://x', { headers: { Authorization: 'Bearer tok123' } });
    expect(extractToken(req)).toBe('tok123');
  });

  test('extractToken falls back to auth_token cookie', () => {
    const req = new Request('http://x', { headers: { Cookie: 'auth_token=cook456' } });
    expect(extractToken(req)).toBe('cook456');
  });

  test('extractToken returns null when absent', () => {
    expect(extractToken(new Request('http://x'))).toBeNull();
  });

  test('serializeCookie emits attributes', () => {
    const s = serializeCookie({
      name: 'auth_token',
      value: 'v',
      options: { httpOnly: true, sameSite: 'strict', maxAge: 60, path: '/' },
    });
    expect(s).toContain('auth_token=v');
    expect(s).toContain('HttpOnly');
    expect(s).toContain('SameSite=Strict');
    expect(s).toContain('Max-Age=60');
    expect(s).toContain('Path=/');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/cookies.test.ts`
Expected: FAIL — cannot find module `../cookies`.

- [ ] **Step 3: Implement `apps/landing/server/cookies.ts`**

```typescript
export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) out[name] = rest.join('='); // values may contain '='
  }
  return out;
}

export function extractToken(req: Request, cookieName = 'auth_token'): string | null {
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers.get('Cookie');
  if (cookie) {
    const cookies = parseCookies(cookie);
    if (cookies[cookieName]) return cookies[cookieName];
  }
  return null;
}

interface CookieConfig {
  name: string;
  value: string;
  options: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
    maxAge?: number;
    path?: string;
  };
}

export function serializeCookie(cfg: CookieConfig): string {
  const o = cfg.options;
  const parts = [`${cfg.name}=${cfg.value}`];
  if (o.maxAge != null) parts.push(`Max-Age=${o.maxAge}`);
  if (o.path) parts.push(`Path=${o.path}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.sameSite) parts.push(`SameSite=${o.sameSite[0].toUpperCase()}${o.sameSite.slice(1)}`);
  return parts.join('; ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/landing && bun test server/tests/cookies.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/landing/server/cookies.ts apps/landing/server/tests/cookies.test.ts
git commit --no-verify -m "feat(landing): cookie parse/serialize helpers"
```

---

### Task 3: In-memory rate limiter

**Files:**
- Create: `apps/landing/server/rate-limit.ts`
- Test: `apps/landing/server/tests/rate-limit.test.ts`

**Interfaces:**
- Produces: `createRateLimiter(opts: { limit: number; windowMs: number }): { check(key: string): { allowed: boolean; retryAfterMs: number } }`. Sliding window per key; `retryAfterMs` is 0 when allowed.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/server/tests/rate-limit.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { createRateLimiter } from '../rate-limit';

describe('rate-limit', () => {
  test('allows up to limit then blocks', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    const third = rl.check('a');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  test('keys are independent', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/rate-limit.test.ts`
Expected: FAIL — cannot find module `../rate-limit`.

- [ ] **Step 3: Implement `apps/landing/server/rate-limit.ts`**

```typescript
// In-memory sliding-window limiter. Single-process only (dev/test); not distributed.
export function createRateLimiter(opts: { limit: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  return {
    check(key: string): { allowed: boolean; retryAfterMs: number } {
      const now = Date.now();
      const cutoff = now - opts.windowMs;
      const times = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (times.length >= opts.limit) {
        const retryAfterMs = times[0] + opts.windowMs - now;
        hits.set(key, times);
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1) };
      }
      times.push(now);
      hits.set(key, times);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/landing && bun test server/tests/rate-limit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/landing/server/rate-limit.ts apps/landing/server/tests/rate-limit.test.ts
git commit --no-verify -m "feat(landing): in-memory rate limiter"
```

---

### Task 4: Turnkey client singleton + `getEd25519Account` (ported)

**Files:**
- Create: `apps/landing/server/turnkey.ts`
- Test: `apps/landing/server/tests/turnkey.test.ts`
- Reference: `~/Projects/aviarytech/poo-app/convex/turnkeyHelpers.ts`

**Interfaces:**
- Consumes: `createTurnkeyClient` from `@originals/auth/server`.
- Produces: `getTurnkey(): Turnkey` (memoized; reads env via `createTurnkeyClient`); `type TurnkeyLike` (minimal shape used by `getEd25519Account`); `getEd25519Account(turnkey, subOrgId): Promise<{ address: string; verificationMethodId: string; signingOrganizationId: string }>`.

- [ ] **Step 1: Write the failing test (mock Turnkey)**

Create `apps/landing/server/tests/turnkey.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { getEd25519Account, type TurnkeyLike } from '../turnkey';

function mockTurnkey(): TurnkeyLike {
  return {
    apiClient: () => ({
      getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
      getWalletAccounts: async () => ({
        accounts: [
          { curve: 'CURVE_SECP256K1', address: '0xeth', organizationId: 'sub1' },
          { curve: 'CURVE_ED25519', address: 'SoLAnaAddr', organizationId: 'sub1' },
        ],
      }),
    }),
  } as unknown as TurnkeyLike;
}

describe('getEd25519Account', () => {
  test('selects the ed25519 account and builds did:key', async () => {
    const res = await getEd25519Account(mockTurnkey(), 'sub1');
    expect(res.address).toBe('SoLAnaAddr');
    expect(res.verificationMethodId).toBe('did:key:SoLAnaAddr');
    expect(res.signingOrganizationId).toBe('sub1');
  });

  test('throws when no ed25519 account', async () => {
    const tk = {
      apiClient: () => ({
        getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
        getWalletAccounts: async () => ({ accounts: [{ curve: 'CURVE_SECP256K1', address: '0x' }] }),
      }),
    } as unknown as TurnkeyLike;
    await expect(getEd25519Account(tk, 'sub1')).rejects.toThrow('No Ed25519 account');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/turnkey.test.ts`
Expected: FAIL — cannot find module `../turnkey`.

- [ ] **Step 3: Implement `apps/landing/server/turnkey.ts`**

```typescript
import { createTurnkeyClient } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';

let cached: Turnkey | null = null;

export function getTurnkey(): Turnkey {
  if (!cached) cached = createTurnkeyClient(); // reads TURNKEY_* env; throws if missing
  return cached;
}

// Minimal structural type so getEd25519Account is testable with a mock.
export type TurnkeyLike = {
  apiClient: () => {
    getWallets: (a: { organizationId: string }) => Promise<{ wallets?: { walletId: string }[] }>;
    getWalletAccounts: (a: { organizationId: string; walletId: string }) => Promise<{
      accounts?: { curve: string; address: string; organizationId?: string }[];
    }>;
  };
};

// Ported from boop convex/turnkeyHelpers.ts. The PARENT Turnkey API key can
// read wallets/accounts and sign for a sub-org (proven in production).
export async function getEd25519Account(turnkey: TurnkeyLike, subOrgId: string) {
  const walletsResponse = await turnkey.apiClient().getWallets({ organizationId: subOrgId });
  const wallets = walletsResponse.wallets;
  if (!wallets || wallets.length === 0) throw new Error('No wallets found for sub-org');

  const accountsResponse = await turnkey
    .apiClient()
    .getWalletAccounts({ organizationId: subOrgId, walletId: wallets[0].walletId });
  const accounts = accountsResponse.accounts;
  if (!accounts || accounts.length === 0) throw new Error('No wallet accounts found for sub-org');

  const ed = accounts.find((a) => a.curve === 'CURVE_ED25519');
  if (!ed) throw new Error('No Ed25519 account found in wallet');

  const signingOrganizationId = ed.organizationId || subOrgId;
  return {
    address: ed.address,
    verificationMethodId: `did:key:${ed.address}`,
    signingOrganizationId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/landing && bun test server/tests/turnkey.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/landing/server/turnkey.ts apps/landing/server/tests/turnkey.test.ts
git commit --no-verify -m "feat(landing): turnkey client singleton + ed25519 account lookup"
```

---

### Task 5: Auth route handlers (send-otp, verify-otp, me, logout)

**Files:**
- Create: `apps/landing/server/auth-routes.ts`
- Test: `apps/landing/server/tests/auth-routes.test.ts`

**Interfaces:**
- Consumes: `json` (Task 1); `serializeCookie`, `extractToken` (Task 2); `createRateLimiter` (Task 3); from `@originals/auth/server`: `initiateEmailAuth`, `verifyEmailAuth`, `signToken`, `verifyToken`, `getAuthCookieConfig`, `getClearAuthCookieConfig`, `type SessionStorage`.
- Produces: `createAuthRoutes(deps: { turnkey: Turnkey; sessions: SessionStorage; jwtSecret: string }): { sendOtp: Handler; verifyOtp: Handler; me: Handler; logout: Handler }`. `sendOtp` rate-limits by IP+email then `initiateEmailAuth`; `verifyOtp` calls `verifyEmailAuth(..., { publicKey })`, then `signToken`, sets cookie; `me` verifies cookie; `logout` clears cookie.

- [ ] **Step 1: Write the failing test (injected mock Turnkey + real session store)**

Create `apps/landing/server/tests/auth-routes.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { createInMemorySessionStorage, type SessionStorage } from '@originals/auth/server';
import { createAuthRoutes } from '../auth-routes';

const JWT_SECRET = 'test-secret-please-change';

// Turnkey mock: initOtp returns an id + a dummy target bundle; verifyOtp returns a token;
// sub-org lookup/create returns a stable id. Enough to drive the 2.0 flow without real Turnkey.
function mockTurnkey() {
  return {
    apiClient: () => ({
      initOtp: async () => ({ otpId: 'otp1', otpEncryptionTargetBundle: 'bundle1' }),
      getSubOrgIds: async () => ({ organizationIds: ['subABC'] }),
      getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
    }),
  } as any;
}

let sessions: SessionStorage;
beforeEach(() => {
  sessions = createInMemorySessionStorage();
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.TURNKEY_ORGANIZATION_ID = 'parentOrg';
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('auth-routes', () => {
  test('sendOtp rejects invalid email', async () => {
    const { sendOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const res = await sendOtp(post('/api/auth/send-otp', { email: 'nope' }), new URL('http://x/api/auth/send-otp'));
    expect(res.status).toBe(400);
  });

  test('sendOtp returns a sessionId and does NOT provision a sub-org', async () => {
    const { sendOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const res = await sendOtp(post('/api/auth/send-otp', { email: 'a@b.com' }), new URL('http://x/api/auth/send-otp'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    // Deferred provisioning: no subOrgId on the session yet.
    const session = sessions.get(body.sessionId);
    expect(session?.subOrgId).toBeUndefined();
  });

  test('sendOtp rate-limits repeated calls for same email', async () => {
    const { sendOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const url = new URL('http://x/api/auth/send-otp');
    // limit is 5/window in impl; 6th must 429
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await sendOtp(post('/api/auth/send-otp', { email: 'rl@b.com' }, { 'x-forwarded-for': '1.1.1.1' }), url);
    }
    expect(last!.status).toBe(429);
  });

  test('me returns 401 without a cookie', async () => {
    const { me } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const res = await me(new Request('http://x/api/me'), new URL('http://x/api/me'));
    expect(res.status).toBe(401);
  });

  test('me returns the payload for a valid token', async () => {
    const { signToken } = await import('@originals/auth/server');
    const token = signToken('subABC', 'a@b.com', undefined, { secret: JWT_SECRET });
    const { me } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const req = new Request('http://x/api/me', { headers: { Cookie: `auth_token=${token}` } });
    const res = await me(req, new URL('http://x/api/me'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subOrgId: 'subABC', email: 'a@b.com' });
  });

  test('logout clears the cookie', async () => {
    const { logout } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const res = await logout(post('/api/auth/logout', {}), new URL('http://x/api/auth/logout'));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
```

> Note on the verify-otp happy path: it requires `verifyEmailAuth` to succeed, which calls the real `encryptOtpCode` against `otpEncryptionTargetBundle` and Turnkey's `verifyOtp`. That path is covered by the manual E2E checklist (Task 12) — the unit tests above cover send/me/logout/rate-limit deterministically. Add a verify-otp **failure** test to prove the handler surfaces errors:

```typescript
  test('verifyOtp rejects malformed code before Turnkey', async () => {
    const { sendOtp, verifyOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const s = await (await sendOtp(post('/api/auth/send-otp', { email: 'v@b.com' }), new URL('http://x/api/auth/send-otp'))).json();
    const res = await verifyOtp(post('/api/auth/verify-otp', { sessionId: s.sessionId, code: 'abc' }), new URL('http://x/api/auth/verify-otp'));
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/auth-routes.test.ts`
Expected: FAIL — cannot find module `../auth-routes`.

- [ ] **Step 3: Implement `apps/landing/server/auth-routes.ts`**

```typescript
import {
  initiateEmailAuth,
  verifyEmailAuth,
  signToken,
  verifyToken,
  getAuthCookieConfig,
  getClearAuthCookieConfig,
  type SessionStorage,
} from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, type Handler } from './router';
import { serializeCookie, extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
}

export function createAuthRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): { sendOtp: Handler; verifyOtp: Handler; me: Handler; logout: Handler } {
  // Per-IP and per-email limiters (README: throttle both).
  const ipLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
  const emailLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });

  const sendOtp: Handler = async (req) => {
    const { email } = (await req.json().catch(() => ({}))) as { email?: string };
    if (!email || !EMAIL_RE.test(email)) return json({ message: 'Invalid email format' }, 400);

    const normalized = email.trim().toLowerCase();
    const ip = ipLimiter.check(clientIp(req));
    const em = emailLimiter.check(normalized);
    if (!ip.allowed || !em.allowed) {
      const retryAfterMs = Math.max(ip.retryAfterMs, em.retryAfterMs);
      return json({ message: 'Too many requests. Please try again later.' }, 429, {
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
      });
    }

    try {
      const result = await initiateEmailAuth(normalized, deps.turnkey, deps.sessions);
      return json(result); // { sessionId, message }
    } catch (e) {
      return json({ message: e instanceof Error ? e.message : 'Failed to send code' }, 500);
    }
  };

  const verifyOtp: Handler = async (req) => {
    const { sessionId, code, publicKey } = (await req.json().catch(() => ({}))) as {
      sessionId?: string;
      code?: string;
      publicKey?: string;
    };
    if (!sessionId || !code) return json({ message: 'Session ID and code are required' }, 400);

    try {
      const result = await verifyEmailAuth(sessionId, code, deps.turnkey, deps.sessions, { publicKey });
      if (!result.verified || !result.subOrgId || !result.email) {
        return json({ message: 'Verification failed' }, 400);
      }
      const token = signToken(result.subOrgId, result.email, undefined, { secret: deps.jwtSecret });
      const cookie = serializeCookie(getAuthCookieConfig(token));
      return json(
        { verified: true, email: result.email, subOrgId: result.subOrgId },
        200,
        { 'Set-Cookie': cookie }
      );
    } catch (e) {
      return json({ message: e instanceof Error ? e.message : 'Verification failed' }, 400);
    }
  };

  const me: Handler = async (req) => {
    const token = extractToken(req);
    if (!token) return json({ message: 'Not authenticated' }, 401);
    try {
      const payload = verifyToken(token, { secret: deps.jwtSecret });
      return json({ subOrgId: payload.sub, email: payload.email });
    } catch {
      return json({ message: 'Invalid or expired token' }, 401);
    }
  };

  const logout: Handler = async () => {
    const cookie = serializeCookie(getClearAuthCookieConfig());
    return json({ success: true }, 200, { 'Set-Cookie': cookie });
  };

  return { sendOtp, verifyOtp, me, logout };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/landing && bun test server/tests/auth-routes.test.ts`
Expected: PASS (all tests including the malformed-code + rate-limit cases).

- [ ] **Step 5: Commit**

```bash
git add apps/landing/server/auth-routes.ts apps/landing/server/tests/auth-routes.test.ts
git commit --no-verify -m "feat(landing): auth routes (send/verify/me/logout) on @originals/auth 2.0"
```

---

### Task 6: Wire routes into `index.ts` + Vite proxy + `.env.example`

**Files:**
- Modify: `apps/landing/server/index.ts`
- Create: `apps/landing/server/.env.example`
- Modify: `apps/landing/vite.config.ts:17` (the `defineConfig({...})` object — add `server.proxy`)
- Test: `apps/landing/server/tests/index.smoke.test.ts`

**Interfaces:**
- Consumes: `createAuthRoutes` (Task 5); `getTurnkey` (Task 4); `createInMemorySessionStorage` from `@originals/auth/server`.
- Produces: a `buildRoutes(deps)` export (so a smoke test can exercise the wired route table without opening a socket).

- [ ] **Step 1: Write the failing test**

Create `apps/landing/server/tests/index.smoke.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { createInMemorySessionStorage } from '@originals/auth/server';
import { buildRoutes } from '../index';
import { route } from '../router';

describe('index route table', () => {
  test('health + auth routes are registered', async () => {
    process.env.JWT_SECRET = 'test-secret';
    const routes = buildRoutes({
      turnkey: { apiClient: () => ({}) } as any,
      sessions: createInMemorySessionStorage(),
      jwtSecret: 'test-secret',
    });
    const health = await route(new Request('http://x/api/health'), routes);
    expect(health.status).toBe(200);
    const me = await route(new Request('http://x/api/me'), routes);
    expect(me.status).toBe(401); // registered, and unauthenticated
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/index.smoke.test.ts`
Expected: FAIL — `buildRoutes` is not exported.

- [ ] **Step 3: Rewrite `apps/landing/server/index.ts`**

```typescript
import { createInMemorySessionStorage, type SessionStorage } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, route, type Handler } from './router';
import { getTurnkey } from './turnkey';
import { createAuthRoutes } from './auth-routes';
import { createDidRoutes } from './did-routes'; // added in Phase 2; safe no-op table until then

export function buildRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): Record<string, Handler> {
  const auth = createAuthRoutes(deps);
  const did = createDidRoutes(deps);
  return {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': auth.sendOtp,
    'POST /api/auth/verify-otp': auth.verifyOtp,
    'GET /api/me': auth.me,
    'POST /api/auth/logout': auth.logout,
    'POST /api/did/create': did.createDid,
  };
}

if (import.meta.main) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET environment variable is required');
  const routes = buildRoutes({
    turnkey: getTurnkey(),
    sessions: createInMemorySessionStorage(),
    jwtSecret,
  });
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8787),
    fetch: (req) => route(req, routes),
  });
  console.log(`[auth-server] listening on http://localhost:${server.port}`);
}
```

> Because `index.ts` now imports `./did-routes`, create a minimal stub so Phase 1 compiles and runs. Create `apps/landing/server/did-routes.ts`:

```typescript
import type { SessionStorage } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, type Handler } from './router';

// Real implementation lands in Phase 2 (Task 11).
export function createDidRoutes(_deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): { createDid: Handler } {
  return { createDid: () => json({ message: 'Not implemented' }, 501) };
}
```

- [ ] **Step 4: Create `apps/landing/server/.env.example`**

```bash
# Turnkey parent-org API credentials (server-only)
TURNKEY_API_PUBLIC_KEY=
TURNKEY_API_PRIVATE_KEY=
TURNKEY_ORGANIZATION_ID=
# Optional: defaults to https://api.turnkey.com
TURNKEY_API_BASE_URL=

# JWT signing secret for the session cookie
JWT_SECRET=

# Domain used for did:webvh creation (e.g. magby.originals.build)
WEBVH_DOMAIN=magby.originals.build

# Server port (default 8787)
PORT=8787
```

- [ ] **Step 5: Add the dev proxy to `apps/landing/vite.config.ts`**

Inside the `defineConfig({ ... })` object (alongside `plugins`, `resolve`, `define`), add:

```typescript
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/landing && bun test server/tests/index.smoke.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole server test suite + start the server manually**

Run: `cd apps/landing && bun test server/`
Expected: all server tests PASS.
Run: `cd apps/landing && JWT_SECRET=dev TURNKEY_API_PUBLIC_KEY=x TURNKEY_API_PRIVATE_KEY=x TURNKEY_ORGANIZATION_ID=x bun run server/index.ts` then in another shell `curl -s localhost:8787/api/health`
Expected: `{"status":"ok"}`. Stop the server (Ctrl-C).

- [ ] **Step 8: Commit**

```bash
git add apps/landing/server/index.ts apps/landing/server/did-routes.ts apps/landing/server/.env.example apps/landing/vite.config.ts apps/landing/server/tests/index.smoke.test.ts
git commit --no-verify -m "feat(landing): wire server routes, vite /api proxy, env example"
```

---

### Task 7: Client network layer (`auth/api.ts`)

**Files:**
- Create: `apps/landing/src/auth/api.ts`
- Test: `apps/landing/src/auth/api.test.ts`

**Interfaces:**
- Consumes: `sendOtp` and `verifyOtp` from `@originals/auth/client`; `generateP256KeyPair` from `@turnkey/crypto`.
- Produces: `startOtp(email): Promise<{ sessionId: string; message: string }>`; `completeOtp(sessionId, code): Promise<{ verified: boolean; email: string; subOrgId: string }>` (generates the browser P-256 keypair and passes `publicKey`); `fetchMe(): Promise<{ subOrgId: string; email: string } | null>`; `createDid(): Promise<{ did: string }>`; `logout(): Promise<void>`. All use same-origin `/api/*` (default endpoints of the client helpers already match).

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/auth/api.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { fetchMe } from './api';

describe('auth/api fetchMe', () => {
  test('returns null on 401', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    try {
      expect(await fetchMe()).toBeNull();
    } finally {
      globalThis.fetch = orig;
    }
  });

  test('returns payload on 200', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ subOrgId: 's', email: 'e@x.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      expect(await fetchMe()).toEqual({ subOrgId: 's', email: 'e@x.com' });
    } finally {
      globalThis.fetch = orig;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/auth/api.test.ts`
Expected: FAIL — cannot find module `./api`.

- [ ] **Step 3: Implement `apps/landing/src/auth/api.ts`**

```typescript
import { sendOtp, verifyOtp } from '@originals/auth/client';
import { generateP256KeyPair } from '@turnkey/crypto';

export interface AuthUser {
  subOrgId: string;
  email: string;
}

export async function startOtp(email: string): Promise<{ sessionId: string; message: string }> {
  return sendOtp(email); // POST /api/auth/send-otp (default endpoint)
}

export async function completeOtp(
  sessionId: string,
  code: string
): Promise<{ verified: boolean; email: string; subOrgId: string }> {
  // Generate the P-256 keypair in the browser so the verification-token
  // private key never transits HTTP (2.0 token binding).
  const keyPair = generateP256KeyPair();
  const result = await verifyOtp(sessionId, code, undefined, { publicKey: keyPair.publicKey });
  return { verified: result.verified, email: result.email!, subOrgId: result.subOrgId! };
}

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (!res.ok) return null;
  return (await res.json()) as AuthUser;
}

export async function createDid(): Promise<{ did: string }> {
  const res = await fetch('/api/did/create', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) throw new Error(((await res.json()) as { message?: string }).message ?? 'DID creation failed');
  return (await res.json()) as { did: string };
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/landing && bun test src/auth/api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/auth/api.ts apps/landing/src/auth/api.test.ts
git commit --no-verify -m "feat(landing): client auth api with browser P-256 binding"
```

---

### Task 8: `useAuth` context/provider

**Files:**
- Create: `apps/landing/src/auth/useAuth.tsx`

**Interfaces:**
- Consumes: `startOtp`, `completeOtp`, `fetchMe`, `createDid`, `logout`, `type AuthUser` (Task 7).
- Produces: `AuthProvider` component; `useAuth(): { user: AuthUser | null; isAuthenticated: boolean; isLoading: boolean; sessionId: string | null; startOtp(email): Promise<void>; verify(code): Promise<void>; createIdentity(): Promise<string>; signOut(): Promise<void> }`.

- [ ] **Step 1: Implement `apps/landing/src/auth/useAuth.tsx`**

```typescript
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import * as api from './api';
import type { AuthUser } from './api';

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionId: string | null;
  startOtp: (email: string) => Promise<void>;
  verify: (code: string) => Promise<void>;
  createIdentity: () => Promise<string>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    api.fetchMe().then(setUser).finally(() => setIsLoading(false));
  }, []);

  const startOtp = useCallback(async (email: string) => {
    const { sessionId } = await api.startOtp(email);
    setSessionId(sessionId);
  }, []);

  const verify = useCallback(async (code: string) => {
    if (!sessionId) throw new Error('Start the OTP flow first');
    const result = await api.completeOtp(sessionId, code);
    setUser({ subOrgId: result.subOrgId, email: result.email });
    setSessionId(null);
  }, [sessionId]);

  const createIdentity = useCallback(async () => {
    const { did } = await api.createDid();
    return did;
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated: !!user, isLoading, sessionId, startOtp, verify, createIdentity, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/landing && bun run typecheck`
Expected: no errors from `useAuth.tsx` (unused-import errors elsewhere are addressed as their tasks land).

- [ ] **Step 3: Commit**

```bash
git add apps/landing/src/auth/useAuth.tsx
git commit --no-verify -m "feat(landing): useAuth context/provider"
```

---

### Task 9: OtpInput component (ported)

**Files:**
- Create: `apps/landing/src/components/OtpInput.tsx`
- Create: `apps/landing/src/components/otp-input.css`
- Source: `~/Projects/aviarytech/poo-app/src/components/auth/OtpInput.tsx`

**Interfaces:**
- Produces: `OtpInput({ onComplete, isLoading?, error?, onResend? })` — 6-digit input; calls `onComplete(code)` once per complete code.

- [ ] **Step 1: Copy the component from boop and adapt**

Copy `~/Projects/aviarytech/poo-app/src/components/auth/OtpInput.tsx` to `apps/landing/src/components/OtpInput.tsx` verbatim (it has no boop-specific imports — pure React). Then:
1. Replace any `className` values that reference boop's stylesheet with the class names used in `otp-input.css` below (`otp-input`, `otp-digit`, `otp-error`, `otp-resend`).
2. Ensure the import line reads `import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent, type ChangeEvent } from 'react';`.

- [ ] **Step 2: Create `apps/landing/src/components/otp-input.css`**

```css
.otp-input { display: flex; flex-direction: column; gap: 0.75rem; align-items: center; }
.otp-input .otp-row { display: flex; gap: 0.5rem; }
.otp-digit {
  width: 2.75rem; height: 3.25rem; text-align: center;
  font-size: 1.4rem; font-variant-numeric: tabular-nums;
  border: 1px solid var(--border, #33333a); border-radius: 8px;
  background: var(--surface, #16151c); color: inherit;
}
.otp-digit:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.otp-error { color: #ff6b6b; font-size: 0.85rem; }
.otp-resend { background: none; border: none; color: var(--accent); cursor: pointer; font: inherit; }
.otp-resend:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 3: Import the css at the top of `OtpInput.tsx`**

Add `import './otp-input.css';` after the React import. Wrap the 6 digit inputs in a `<div className="otp-row">` if not already, matching the css.

- [ ] **Step 4: Typecheck**

Run: `cd apps/landing && bun run typecheck`
Expected: no errors from `OtpInput.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/components/OtpInput.tsx apps/landing/src/components/otp-input.css
git commit --no-verify -m "feat(landing): OtpInput component (ported from boop)"
```

---

### Task 10: LoginModal component

**Files:**
- Create: `apps/landing/src/components/LoginModal.tsx`
- Create: `apps/landing/src/components/login-modal.css`
- Reference: `~/Projects/aviarytech/poo-app/src/pages/Login.tsx` (two-step flow logic)

**Interfaces:**
- Consumes: `useAuth` (Task 8); `OtpInput` (Task 9).
- Produces: `LoginModal({ open, onClose })` — email step → OTP step; closes on successful auth.

- [ ] **Step 1: Implement `apps/landing/src/components/LoginModal.tsx`**

```typescript
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/useAuth';
import { OtpInput } from './OtpInput';
import './login-modal.css';

type Step = 'email' | 'otp';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { startOtp, verify } = useAuth();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) return setError('Please enter a valid email address');
    setBusy(true);
    try {
      await startOtp(value);
      setStep('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (code: string) => {
    setError(null);
    setBusy(true);
    try {
      await verify(code);
      onClose();
      setStep('email');
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="login-modal" onClick={(e) => e.stopPropagation()}>
        <button className="login-close" aria-label="Close" onClick={onClose}>×</button>
        {step === 'email' ? (
          <form onSubmit={submitEmail} className="login-form">
            <h2>Sign in</h2>
            <p className="login-sub">We'll email you a 6-digit code.</p>
            <input
              type="email"
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="login-email"
            />
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <div className="login-form">
            <h2>Enter your code</h2>
            <p className="login-sub">Sent to {email}</p>
            <OtpInput onComplete={submitCode} isLoading={busy} error={error} onResend={() => submitEmail(new Event('submit') as unknown as FormEvent)} />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `apps/landing/src/components/login-modal.css`**

```css
.login-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0.55); display: grid; place-items: center; padding: 1rem;
}
.login-modal {
  position: relative; width: min(26rem, 100%);
  background: var(--surface, #16151c); border: 1px solid var(--border, #2a2933);
  border-radius: 16px; padding: 2rem;
}
.login-close { position: absolute; top: 0.75rem; right: 0.9rem; background: none; border: none; font-size: 1.5rem; color: inherit; cursor: pointer; }
.login-form { display: flex; flex-direction: column; gap: 0.9rem; }
.login-form h2 { margin: 0; }
.login-sub { margin: 0; opacity: 0.7; font-size: 0.9rem; }
.login-email { padding: 0.7rem 0.9rem; border-radius: 8px; border: 1px solid var(--border, #33333a); background: var(--bg, #0c0b10); color: inherit; font: inherit; }
.login-error { color: #ff6b6b; font-size: 0.85rem; margin: 0; }
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/landing && bun run typecheck`
Expected: no errors from `LoginModal.tsx`.

- [ ] **Step 4: Commit**

```bash
git add apps/landing/src/components/LoginModal.tsx apps/landing/src/components/login-modal.css
git commit --no-verify -m "feat(landing): LoginModal (email + OTP steps)"
```

---

### Task 11: Nav integration + AuthProvider

**Files:**
- Modify: `apps/landing/src/main.tsx`
- Modify: `apps/landing/src/components/Nav.tsx`

**Interfaces:**
- Consumes: `AuthProvider`, `useAuth` (Task 8); `LoginModal` (Task 10).

- [ ] **Step 1: Wrap the app in `AuthProvider` in `apps/landing/src/main.tsx`**

Add `import { AuthProvider } from './auth/useAuth';` and change the render body to:

```tsx
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
```

- [ ] **Step 2: Add auth UI to `apps/landing/src/components/Nav.tsx`**

At the top of the file add:

```tsx
import { useAuth } from '../auth/useAuth';
import { LoginModal } from './LoginModal';
```

Inside `Nav()`, add state and auth:

```tsx
  const { isAuthenticated, user, createIdentity, signOut } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  const [did, setDid] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
```

Replace the existing `<a className="btn btn-primary nav-cta" ...>` CTA block in `.nav-actions` with:

```tsx
          {isAuthenticated ? (
            <div className="nav-auth">
              <span className="nav-email" title={user!.email}>{user!.email}</span>
              <button
                className="btn btn-primary"
                disabled={creating}
                onClick={async () => {
                  setCreating(true);
                  try { setDid(await createIdentity()); }
                  catch (e) { alert(e instanceof Error ? e.message : 'DID creation failed'); }
                  finally { setCreating(false); }
                }}
              >
                {creating ? 'Creating…' : did ? 'Identity ✓' : 'Create your did:webvh'}
              </button>
              <button className="nav-signout" onClick={() => signOut()}>Sign out</button>
            </div>
          ) : (
            <button className="btn btn-primary nav-cta" onClick={() => setLoginOpen(true)}>
              Sign in
            </button>
          )}
```

At the end of the returned `<header>…</header>` JSX (just before the closing fragment/element), render the modal and, when present, the DID:

```tsx
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      {did && <div className="nav-did" title={did}>{did}</div>}
```

Add matching styles at the end of `apps/landing/src/components/nav.css`:

```css
.nav-auth { display: flex; align-items: center; gap: 0.6rem; }
.nav-email { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.8; font-size: 0.85rem; }
.nav-signout { background: none; border: none; color: inherit; opacity: 0.7; cursor: pointer; font: inherit; }
.nav-did { position: absolute; right: 1rem; top: 100%; font-family: var(--mono, monospace); font-size: 0.72rem; max-width: 90vw; overflow: hidden; text-overflow: ellipsis; background: var(--surface,#16151c); padding: 0.3rem 0.6rem; border-radius: 6px; }
```

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/landing && bun run typecheck && bun run build`
Expected: typecheck clean; production build succeeds (the `@turnkey/crypto` browser-compat risk surfaces here — see Risk in the spec; if a `node:crypto` primitive is missing, extend `src/shims/crypto.ts` or swap `generateP256KeyPair` for a WebCrypto P-256 generation).

- [ ] **Step 4: Manual smoke — the UI renders and opens the modal**

Run: `cd apps/landing && bun run dev` and open the served URL; click **Sign in**; the modal appears with the email step.
Expected: modal opens/closes; no console errors. (Full OTP round-trip needs real Turnkey — Task 12.)

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/main.tsx apps/landing/src/components/Nav.tsx apps/landing/src/components/nav.css
git commit --no-verify -m "feat(landing): nav sign-in + authed state + AuthProvider"
```

---

### Task 12: Server README + manual E2E checklist

**Files:**
- Create: `apps/landing/server/README.md`

- [ ] **Step 1: Write `apps/landing/server/README.md`**

````markdown
# Landing auth server

Standalone Bun server exercising `@originals/auth` 2.0 email-OTP auth for the landing page.

## Run

1. Build the auth package: `cd ../../packages/auth && bun run build`
2. Copy env: `cp .env.example .env` and fill in real Turnkey creds + `JWT_SECRET`.
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
````

- [ ] **Step 2: Commit**

```bash
git add apps/landing/server/README.md
git commit --no-verify -m "docs(landing): auth server README + manual E2E checklist"
```

---

## PHASE 2 — did:webvh creation

The Turnkey signer itself was not changed on this branch, so this phase is additive. It starts with a verification spike because the exact multibase derivation depends on real Turnkey account shapes.

---

### Task 13: Verify Turnkey account shape + multibase derivation (spike)

**Files:**
- Create: `apps/landing/server/tests/multibase.test.ts`
- Create: `apps/landing/server/multibase.ts`

**Interfaces:**
- Produces: `solanaAddressToEd25519Multibase(address: string): string` — base58-decode the Solana address (32-byte raw ed25519 pubkey) → prepend multicodec `0xed 0x01` → base58btc-encode with multibase `z` prefix. Mirrors `toPublicKeyMultibase` in `packages/auth/tests/turnkey-did-creation.integration.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/server/tests/multibase.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { encoding } from '@originals/sdk';
import { solanaAddressToEd25519Multibase } from '../multibase';

describe('solanaAddressToEd25519Multibase', () => {
  test('round-trips a known 32-byte key through base58', () => {
    const raw = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
    // Solana address is base58btc of the raw key WITHOUT multibase prefix.
    const solanaAddress = encoding.multibase.encode(raw, 'base58btc').slice(1);
    const multibase = solanaAddressToEd25519Multibase(solanaAddress);
    // Multikey = 'z' + base58btc(0xed01 || raw)
    const prefixed = new Uint8Array([0xed, 0x01, ...raw]);
    expect(multibase).toBe(encoding.multibase.encode(prefixed, 'base58btc'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/multibase.test.ts`
Expected: FAIL — cannot find module `../multibase`.

- [ ] **Step 3: Implement `apps/landing/server/multibase.ts`**

```typescript
import { encoding } from '@originals/sdk';

const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

// Turnkey ed25519 accounts use ADDRESS_FORMAT_SOLANA: the address is base58btc
// of the raw 32-byte public key (no multibase prefix). Convert to a Multikey
// publicKeyMultibase string ('z' + base58btc(0xed01 || rawKey)).
export function solanaAddressToEd25519Multibase(address: string): string {
  // encoding.multibase.decode expects a leading multibase code; Solana addresses
  // omit it, so re-add the base58btc 'z' code before decoding.
  const raw = encoding.multibase.decode(`z${address}`);
  if (raw.length !== 32) throw new Error(`Expected 32-byte ed25519 key, got ${raw.length}`);
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + raw.length);
  prefixed.set(ED25519_MULTICODEC);
  prefixed.set(raw, ED25519_MULTICODEC.length);
  return encoding.multibase.encode(prefixed, 'base58btc');
}
```

> If `encoding.multibase.decode`/`encode` signatures differ from the above (verify against `packages/sdk` exports at implementation time — the integration test uses `encoding.multibase.encode(bytes, 'base58btc')`), adjust the calls to match; the algorithm (strip/re-add `z`, prepend `0xed01`) is fixed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/landing && bun test server/tests/multibase.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/server/multibase.ts apps/landing/server/tests/multibase.test.ts
git commit --no-verify -m "feat(landing): Solana-address → ed25519 Multikey derivation"
```

---

### Task 14: `/api/did/create` route (real implementation)

**Files:**
- Modify: `apps/landing/server/did-routes.ts`
- Modify: `apps/landing/server/turnkey.ts` (extend `getEd25519Account` return to include the derived `publicKeyMultibase`)
- Test: `apps/landing/server/tests/did-routes.test.ts`

**Interfaces:**
- Consumes: `extractToken` (Task 2); `verifyToken` from `@originals/auth/server`; `getEd25519Account` (Task 4); `solanaAddressToEd25519Multibase` (Task 13); `TurnkeyWebVHSigner` + `createTurnkeySigner` from `@originals/auth/server`; `createDID` from `didwebvh-ts`.
- Produces: `createDidRoutes` returns a real `createDid: Handler` that: reads the auth cookie → `verifyToken` → `getEd25519Account(subOrgId)` → builds a `TurnkeyWebVHSigner` (parent client signs for sub-org) → `createDID` with `WEBVH_DOMAIN` and slug `user-<subOrgId first16>` → `{ did, didDocument, didLog }`.

- [ ] **Step 1: Extend `getEd25519Account` in `apps/landing/server/turnkey.ts`**

Add the derived Multikey to the return value:

```typescript
import { solanaAddressToEd25519Multibase } from './multibase';
```

At the end of `getEd25519Account`, change the return to:

```typescript
  return {
    address: ed.address,
    publicKeyMultibase: solanaAddressToEd25519Multibase(ed.address),
    verificationMethodId: `did:key:${solanaAddressToEd25519Multibase(ed.address)}`,
    signingOrganizationId,
  };
```

Update `apps/landing/server/tests/turnkey.test.ts` expectations: the mock's `SoLAnaAddr` is not a valid base58 32-byte key, so change the ed25519 mock address to a real one. Replace the mock account address with a generated base58 key and assert `publicKeyMultibase` starts with `z`:

```typescript
import { encoding } from '@originals/sdk';
const raw = new Uint8Array(32).fill(3);
const solAddr = encoding.multibase.encode(raw, 'base58btc').slice(1);
// ...use solAddr as the ed25519 account address in the mock...
// then:
expect(res.publicKeyMultibase.startsWith('z')).toBe(true);
expect(res.verificationMethodId.startsWith('did:key:z')).toBe(true);
```

- [ ] **Step 2: Write the failing test for the route**

Create `apps/landing/server/tests/did-routes.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { createInMemorySessionStorage, signToken } from '@originals/auth/server';
import { encoding } from '@originals/sdk';
import { createDidRoutes } from '../did-routes';

const JWT_SECRET = 'test-secret';

// A Turnkey mock that returns a wallet with a real ed25519 (Solana) account and
// signs payloads with a real ed25519 key so didwebvh-ts's post-sign verification
// passes. Reuse the pattern from packages/auth/tests/turnkey-did-creation.integration.test.ts.
// (Implementer: import @noble/ed25519, generate a keypair, expose signRawPayload
// returning { activity: { result: { signRawPayloadResult: { r, s } } } }.)

test.todo('createDid returns a did:webvh for an authenticated user (real-ed25519 signing mock)');

describe('did-routes auth gate', () => {
  test('rejects unauthenticated requests', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.WEBVH_DOMAIN = 'magby.originals.build';
    const { createDid } = createDidRoutes({
      turnkey: { apiClient: () => ({}) } as any,
      sessions: createInMemorySessionStorage(),
      jwtSecret: JWT_SECRET,
    });
    const res = await createDid(new Request('http://x/api/did/create', { method: 'POST' }), new URL('http://x/api/did/create'));
    expect(res.status).toBe(401);
  });
});
```

> The happy-path signing test is marked `test.todo` because it requires the full real-ed25519 Turnkey mock; port it from `packages/auth/tests/turnkey-did-creation.integration.test.ts` (which already builds exactly this mock) if a deterministic happy-path test is wanted. The auth-gate test runs deterministically now, and the real end-to-end DID creation is covered by the manual checklist (Task 12).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/did-routes.test.ts`
Expected: FAIL — `createDidRoutes` still returns the 501 stub (auth-gate test expects 401).

- [ ] **Step 4: Implement the real `apps/landing/server/did-routes.ts`**

```typescript
import { verifyToken, type SessionStorage } from '@originals/auth/server';
import { TurnkeyWebVHSigner } from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { createDID } from 'didwebvh-ts';
import { json, type Handler } from './router';
import { extractToken } from './cookies';
import { getEd25519Account } from './turnkey';

export function createDidRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): { createDid: Handler } {
  const createDid: Handler = async (req) => {
    const token = extractToken(req);
    if (!token) return json({ message: 'Not authenticated' }, 401);

    let subOrgId: string;
    try {
      subOrgId = verifyToken(token, { secret: deps.jwtSecret }).sub;
    } catch {
      return json({ message: 'Invalid or expired token' }, 401);
    }

    const domain = process.env.WEBVH_DOMAIN;
    if (!domain) return json({ message: 'WEBVH_DOMAIN is not set' }, 500);

    try {
      const { address, publicKeyMultibase, verificationMethodId, signingOrganizationId } =
        await getEd25519Account(deps.turnkey, subOrgId);

      // Parent Turnkey API key signs for the sub-org (proven in boop production).
      const signer = new TurnkeyWebVHSigner(
        signingOrganizationId,
        address, // keyId = signWith
        publicKeyMultibase,
        deps.turnkey,
        verificationMethodId
      );

      const slug = `user-${subOrgId.slice(0, 16)}`;
      const result = await createDID({
        domain,
        signer,
        verifier: signer,
        updateKeys: [verificationMethodId],
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase },
          { id: '#key-1', type: 'Multikey', controller: '', publicKeyMultibase },
        ],
        paths: [slug],
        portable: false,
        authentication: ['#key-0'],
        assertionMethod: ['#key-1'],
      });

      return json({ did: result.did, didDocument: result.doc, didLog: result.log });
    } catch (e) {
      return json({ message: e instanceof Error ? e.message : 'DID creation failed' }, 500);
    }
  };

  return { createDid };
}
```

> This mirrors boop's `createDIDRecord` but with the 2.0 `TurnkeyWebVHSigner` and a **properly derived** `publicKeyMultibase` (Task 13) instead of boop's raw-address shortcut. `didwebvh-ts` is already a dependency of the landing app.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/landing && bun test server/`
Expected: all PASS (the did-routes auth-gate test now returns 401; happy-path remains `test.todo`).

- [ ] **Step 6: Commit**

```bash
git add apps/landing/server/did-routes.ts apps/landing/server/turnkey.ts apps/landing/server/tests/did-routes.test.ts apps/landing/server/tests/turnkey.test.ts
git commit --no-verify -m "feat(landing): real /api/did/create with Turnkey signer (2.0)"
```

---

### Task 15: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole landing test suite**

Run: `cd apps/landing && bun test`
Expected: all server + client-api tests PASS.

- [ ] **Step 2: Typecheck + production build**

Run: `cd apps/landing && bun run typecheck && bun run build`
Expected: clean typecheck; successful build.

- [ ] **Step 3: Confirm the auth package's own tests still pass (untouched, sanity)**

Run: `cd packages/auth && bun test`
Expected: PASS.

- [ ] **Step 4: Execute the manual E2E checklist**

Follow `apps/landing/server/README.md` with real Turnkey creds. Record results.

- [ ] **Step 5: Commit any fixes surfaced by verification**

```bash
git commit --no-verify -am "fix(landing): address verification findings"
```

---

## Self-Review (against the spec)

**Spec coverage:**
- Standalone Bun server at `apps/landing/server/` → Tasks 1,6. ✓
- send-otp / verify-otp / me / logout with 2.0 API → Task 5. ✓
- Deferred provisioning asserted → Task 5 (send-otp test asserts no `subOrgId`). ✓
- Rate limit per IP + per email → Tasks 3,5. ✓
- publicKey binding (browser P-256) → Task 7. ✓
- `/api/did/create` via Turnkey signer → Tasks 13,14. ✓
- `getEd25519Account` ported → Task 4. ✓
- Cookie helpers ported → Task 2. ✓
- OtpInput + LoginModal (boop-derived) → Tasks 9,10. ✓
- Nav sign-in + authed state + AuthProvider → Task 11. ✓
- Vite `/api` proxy → Task 6. ✓
- Deps + build packages/auth + scripts → Tasks 1,6. ✓
- Route-level tests w/ injected mock Turnkey → Tasks 5,14. ✓
- Manual E2E checklist → Task 12. ✓
- Env vars documented → Task 6. ✓
- Risk: `@turnkey/crypto` browser compat → surfaced at Task 11 build step. ✓

**Type consistency:** `Handler` (router) used consistently; `createAuthRoutes`/`createDidRoutes` share the `{ turnkey, sessions, jwtSecret }` deps shape; `getEd25519Account` return shape extended additively in Task 14 (address, publicKeyMultibase, verificationMethodId, signingOrganizationId) with its test updated in the same task; `AuthUser` shape (`{ subOrgId, email }`) consistent across api/useAuth/nav.

**Placeholder scan:** No TBD/"handle errors"/"similar to". The two non-code deferrals are explicit and justified: verify-otp happy path and did-create happy path require the real-ed25519 Turnkey mock (available to port from `packages/auth/tests/turnkey-did-creation.integration.test.ts`) or real creds; both are covered by the manual checklist, and the deterministic error/gate paths are unit-tested.
