# Your Originals — Durable per-user did:webvh + a `/me` collection page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user's Create → Publish produces a real, durable, resolvable did:webvh Original saved to their account; a `/me` "Your Originals" page lists their Originals; and the demo's Inscribe step becomes an honest "Coming soon".

**Architecture:** Add a filesystem-backed durable store (`server/originals-store.ts`) on a Railway volume (`ORIGINALS_DATA_DIR`). Auth-gate three new routes (`PUT /api/originals/host/*`, `POST /api/originals`, `GET /api/originals`) wired through the existing `buildRoutes` (exact paths) + `buildFetch` (the host wildcard + a durable `serve` fallback). In the browser a `DurableHostingStorageAdapter` targets `/api/originals/host/*` with the auth cookie; when the engine is constructed `authed`, `publish()` hosts durably and POSTs a summary. A hand-rolled client router adds `/me`. The anonymous demo path stays ephemeral and unchanged; did:btco stays gated.

**Tech Stack:** Bun (runtime + test runner), TypeScript, `@originals/sdk`, `@originals/auth`, Vite 8 / React 19, `didwebvh-ts`, Node `fs`/`path` (via `node:` specifiers).

## Global Constraints

- **Runtime & tests:** Bun only. Server tests live in `apps/landing/server/tests/*.test.ts`; browser/SDK tests in `apps/landing/src/**/*.test.ts`. Run with `cd apps/landing && bun test <path>`. Import test primitives from `bun:test`. Follow the style of `apps/landing/server/tests/webvh-host.test.ts` and `apps/landing/server/tests/bitcoin.test.ts`.
- **No new dependencies.** No `react-router` — routing is hand-rolled on `history`/`location`. No DB — the store is plain filesystem via `node:fs`/`node:fs/promises`/`node:path`.
- **All `/api/originals*` routes are auth-gated.** Anonymous → `401`. Auth pattern (from `server/bitcoin.ts`): `const token = extractToken(req); if (!token) return json({error:'unauthorized'},401); let sub; try { sub = verifyToken(token,{secret: jwtSecret}).sub } catch { return json({error:'unauthorized'},401) }`.
- **Durable `serve` reuses `untrustedHeaders`** (nosniff + sandbox CSP + attachment) from `server/webvh-host.ts` — exported in Task 1 Step 1.
- **Anonymous demo stays ephemeral/unchanged:** the anonymous Create→Publish keeps using `HttpHostingStorageAdapter` → `PUT /api/host/*` (TTL store). Only an `authed` engine uses the durable path.
- **did:btco / real inscription stays gated and untouched** (`btcTestnetEnabled()` path, `HttpOrdinalsProvider`, `TurnkeySatSigner`, `/api/btc/*`). The Inscribe step's coming-soon state applies only when NOT testnet-enabled.
- **Filesystem safety:** decode keys once, reject any `..` path segment before joining under `dataDir`; `mkdirSync(dirname, { recursive: true })` before writes.
- **Noble imports:** `@noble/hashes/sha2.js` (never `/sha256`). Multikey encoding only — never JWK. (Neither is introduced here; do not add them.)

## File Structure

- `apps/landing/server/originals-store.ts` (new) — durable filesystem store: `saveBytes` / `recordOriginal` / `list` / `serve`, per-user quota, traversal-hardened keys.
- `apps/landing/server/originals-routes.ts` (new) — `createOriginalsRoutes({ jwtSecret, store })` → `{ hostPut, record, list, serve }` (auth-gated handlers + a `serve` passthrough).
- `apps/landing/server/index.ts`, `apps/landing/server/app.ts`, `apps/landing/serve.ts` (modify) — mount + dispatch + wire the store.
- `apps/landing/server/webvh-host.ts` (modify) — export `untrustedHeaders`.
- `apps/landing/src/sdk/durable-hosting-adapter.ts` (new) — browser adapter over `/api/originals/host/*`.
- `apps/landing/src/sdk/engine.ts` (modify) — `authed` constructor opt + durable publish + summary POST.
- `apps/landing/src/router.tsx` (new) — `useLocationPath()` + `navigate()`.
- `apps/landing/src/pages/YourOriginals.tsx` (new) — the `/me` page.
- `apps/landing/src/App.tsx`, `apps/landing/src/components/Nav.tsx`, `apps/landing/src/components/Demo.tsx`, `apps/landing/src/content.ts` (modify) — routing, nav link, inscribe coming-soon, copy.
- `.gitignore` (modify) — ignore `.originals-data`.

---

## Task 1: `server/originals-store.ts` — durable filesystem store

**Files:**
- Modify: `apps/landing/server/webvh-host.ts` (export `untrustedHeaders`)
- Create: `apps/landing/server/originals-store.ts`
- Test: `apps/landing/server/tests/originals-store.test.ts`

**Interfaces:**
- Consumes: `untrustedHeaders` from `./webvh-host`; `node:fs`, `node:path`.
- Produces:
  - `interface OriginalSummary { did: string; title: string; resourceHash: string; createdAt: string; resourceUrl?: string }`
  - `interface OriginalsStore { saveBytes(subOrgId: string, key: string, bytes: Uint8Array, contentType: string): void; recordOriginal(subOrgId: string, o: { did: string; title: string; resourceHash: string; createdAt: string }): void; list(subOrgId: string): OriginalSummary[]; serve(url: URL): Response | null }`
  - `function createOriginalsStore(opts: { dataDir: string; maxOriginals?: number; maxTotalBytes?: number }): OriginalsStore` — quota overflow throws `new Error('STORE_FULL')`; invalid keys/subs throw `new Error('BAD_KEY')`.

- [ ] **Step 1: Export `untrustedHeaders` from `server/webvh-host.ts`**

In `apps/landing/server/webvh-host.ts`, change the helper declaration (near the bottom) from:

```typescript
function untrustedHeaders(contentType: string): Record<string, string> {
```
to:
```typescript
export function untrustedHeaders(contentType: string): Record<string, string> {
```

Confirm the existing suite still passes (no behavior change):

Run: `cd apps/landing && bun test server/tests/webvh-host.test.ts`
Expected: PASS — all existing tests green.

- [ ] **Step 2: Write the failing test**

Create `apps/landing/server/tests/originals-store.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOriginalsStore } from '../originals-store';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'originals-store-'));
}
const enc = (s: string) => new TextEncoder().encode(s);

describe('originals-store', () => {
  test('saveBytes → serve roundtrip at the resolver URL', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const key = 'demo.example.com/studio/you/abc/did.jsonl';
    store.saveBytes('sub-1', key, enc('{"v":1}\n{"v":2}'), 'application/jsonl');

    const url = new URL('http://demo.example.com/studio/you/abc/did.jsonl');
    const served = store.serve(url);
    expect(served).not.toBeNull();
    expect(served!.status).toBe(200);
    expect(served!.headers.get('content-type')).toBe('application/jsonl');
    // Reuses untrustedHeaders (anti-XSS) exactly like the ephemeral host store.
    expect(served!.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served!.headers.get('content-security-policy')).toContain('sandbox');
    expect(served!.headers.get('content-disposition')).toBe('attachment');
  });

  test('serve returns null for an unknown key', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    expect(store.serve(new URL('http://demo.example.com/nope/did.jsonl'))).toBeNull();
  });

  test('record + list roundtrip, with a derived resourceUrl from a saved resource key', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const did = 'did:webvh:SCID:demo.example.com:studio:you:abc';
    // Publish hosts the did log AND the artwork resource under the same path.
    store.saveBytes('sub-1', 'demo.example.com/studio/you/abc/did.jsonl', enc('{}'), 'application/jsonl');
    store.saveBytes('sub-1', 'demo.example.com/studio/you/abc/resources/zR1', enc('<svg/>'), 'image/svg+xml');
    store.recordOriginal('sub-1', { did, title: 'Piece', resourceHash: 'deadbeef', createdAt: '2026-07-21T00:00:00.000Z' });

    const list = store.list('sub-1');
    expect(list.length).toBe(1);
    expect(list[0].did).toBe(did);
    expect(list[0].title).toBe('Piece');
    expect(list[0].resourceHash).toBe('deadbeef');
    expect(list[0].resourceUrl).toBe('https://demo.example.com/studio/you/abc/resources/zR1');
  });

  test('durability across a re-open on the same dir', () => {
    const dir = tmpDir();
    const a = createOriginalsStore({ dataDir: dir });
    a.saveBytes('sub-1', 'demo.example.com/studio/you/abc/did.jsonl', enc('LOG'), 'application/jsonl');
    a.recordOriginal('sub-1', { did: 'did:webvh:S:demo.example.com:studio:you:abc', title: 'T', resourceHash: 'h', createdAt: 'now' });

    // A brand-new store on the same dir sees the persisted data.
    const b = createOriginalsStore({ dataDir: dir });
    expect(b.list('sub-1').length).toBe(1);
    const served = b.serve(new URL('http://demo.example.com/studio/you/abc/did.jsonl'));
    expect(served).not.toBeNull();
  });

  test('rejects path traversal in a key', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    expect(() => store.saveBytes('sub-1', 'demo.example.com/../../etc/passwd', enc('x'), 'text/plain')).toThrow('BAD_KEY');
    // A traversal attempt on serve resolves to a miss, never escapes the dir.
    expect(store.serve(new URL('http://demo.example.com/../../etc/passwd'))).toBeNull();
  });

  test('per-user isolation: one user never sees another user’s originals', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    store.recordOriginal('sub-1', { did: 'did:webvh:S:h:a', title: 'A', resourceHash: 'x', createdAt: 't' });
    store.recordOriginal('sub-2', { did: 'did:webvh:S:h:b', title: 'B', resourceHash: 'y', createdAt: 't' });
    expect(store.list('sub-1').map((o) => o.title)).toEqual(['A']);
    expect(store.list('sub-2').map((o) => o.title)).toEqual(['B']);
  });

  test('quota: too many originals throws STORE_FULL', () => {
    const store = createOriginalsStore({ dataDir: tmpDir(), maxOriginals: 1 });
    store.recordOriginal('sub-1', { did: 'did:webvh:S:h:a', title: 'A', resourceHash: 'x', createdAt: 't' });
    expect(() =>
      store.recordOriginal('sub-1', { did: 'did:webvh:S:h:b', title: 'B', resourceHash: 'y', createdAt: 't' })
    ).toThrow('STORE_FULL');
  });

  test('quota: exceeding total bytes throws STORE_FULL', () => {
    const store = createOriginalsStore({ dataDir: tmpDir(), maxTotalBytes: 8 });
    expect(() =>
      store.saveBytes('sub-1', 'h/a/did.jsonl', enc('this is longer than eight bytes'), 'application/jsonl')
    ).toThrow('STORE_FULL');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/originals-store.test.ts`
Expected: FAIL — `Cannot find module '../originals-store'`.

- [ ] **Step 4: Implement `apps/landing/server/originals-store.ts`**

```typescript
/**
 * Durable, filesystem-backed store for signed-in users' Originals.
 *
 * Two trees under `dataDir`:
 *   hosted/<host>/<path>      the did:webvh log / cel / resource bytes (public;
 *                             served at the resolver's exact URL). A sibling
 *                             <file>.ctype holds the content-type so serve()
 *                             survives a restart.
 *   users/<sub>.json          per-user index { originals, sizes, totalBytes }.
 *
 * Everything reads/writes disk directly, so a fresh store on the same dir sees
 * all prior data (restart durability). Keys are `${domain}/${relativePath}` —
 * identical to the ephemeral host adapter — so serve() looks up
 * `${url.host}${url.pathname}`, byte-identical to the put key.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { untrustedHeaders } from './webvh-host';

export interface OriginalSummary {
  did: string;
  title: string;
  resourceHash: string;
  createdAt: string;
  /** Derived (not stored): the resolvable URL of the artwork resource, for the thumbnail. */
  resourceUrl?: string;
}

interface UserIndex {
  originals: Array<{ did: string; title: string; resourceHash: string; createdAt: string }>;
  sizes: Record<string, number>;
  totalBytes: number;
}

export interface OriginalsStore {
  saveBytes(subOrgId: string, key: string, bytes: Uint8Array, contentType: string): void;
  recordOriginal(
    subOrgId: string,
    o: { did: string; title: string; resourceHash: string; createdAt: string }
  ): void;
  list(subOrgId: string): OriginalSummary[];
  serve(url: URL): Response | null;
}

const CTYPE_SUFFIX = '.ctype';

/** Split a key into safe segments, rejecting empty / dot / traversal segments. */
function keySegments(key: string): string[] {
  const segs = decodeURIComponent(key).split('/').filter((s) => s.length > 0);
  if (segs.length === 0) throw new Error('BAD_KEY');
  for (const s of segs) {
    if (s === '.' || s === '..' || s.includes('\0')) throw new Error('BAD_KEY');
  }
  return segs;
}

/** Absolute path under baseDir for a key; throws if it would escape baseDir. */
function keyToPath(baseDir: string, key: string): string {
  const abs = resolve(baseDir, ...keySegments(key));
  const root = resolve(baseDir) + sep;
  if (!abs.startsWith(root)) throw new Error('BAD_KEY');
  return abs;
}

/** A subOrgId used as a filename — Turnkey sub-orgs are UUID-safe; reject anything else. */
function subFile(dataDir: string, subOrgId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(subOrgId)) throw new Error('BAD_KEY');
  return join(dataDir, 'users', `${subOrgId}.json`);
}

export function createOriginalsStore(opts: {
  dataDir: string;
  maxOriginals?: number;
  maxTotalBytes?: number;
}): OriginalsStore {
  const dataDir = opts.dataDir;
  const maxOriginals = opts.maxOriginals ?? 100;
  const maxTotalBytes = opts.maxTotalBytes ?? 25 * 1024 * 1024; // 25 MiB / user
  const hostedDir = join(dataDir, 'hosted');

  function readIndex(subOrgId: string): UserIndex {
    const path = subFile(dataDir, subOrgId);
    if (!existsSync(path)) return { originals: [], sizes: {}, totalBytes: 0 };
    return JSON.parse(readFileSync(path, 'utf8')) as UserIndex;
  }

  function writeIndex(subOrgId: string, idx: UserIndex): void {
    const path = subFile(dataDir, subOrgId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(idx));
  }

  function saveBytes(subOrgId: string, key: string, bytes: Uint8Array, contentType: string): void {
    const target = keyToPath(hostedDir, key); // validates traversal
    const idx = readIndex(subOrgId);
    const prev = idx.sizes[key] ?? 0;
    const nextTotal = idx.totalBytes - prev + bytes.byteLength;
    if (nextTotal > maxTotalBytes) throw new Error('STORE_FULL');

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    writeFileSync(target + CTYPE_SUFFIX, contentType);

    idx.sizes[key] = bytes.byteLength;
    idx.totalBytes = nextTotal;
    writeIndex(subOrgId, idx);
  }

  function recordOriginal(
    subOrgId: string,
    o: { did: string; title: string; resourceHash: string; createdAt: string }
  ): void {
    const idx = readIndex(subOrgId);
    if (idx.originals.length >= maxOriginals) throw new Error('STORE_FULL');
    idx.originals.push(o);
    writeIndex(subOrgId, idx);
  }

  // did:webvh:<SCID>:<host>[:<seg>…] → the resource-key prefix `${host}/${segs}/resources/`.
  function resourcePrefix(did: string): string | null {
    const parts = did.split(':');
    if (parts.length < 4 || parts[0] !== 'did' || parts[1] !== 'webvh') return null;
    const host = decodeURIComponent(parts[3] ?? '');
    const segs = parts.slice(4).map((s) => decodeURIComponent(s));
    return segs.length ? `${host}/${segs.join('/')}/resources/` : `${host}/resources/`;
  }

  function list(subOrgId: string): OriginalSummary[] {
    const idx = readIndex(subOrgId);
    const keys = Object.keys(idx.sizes);
    return idx.originals.map((o) => {
      const prefix = resourcePrefix(o.did);
      const resourceKey = prefix ? keys.find((k) => k.startsWith(prefix)) : undefined;
      return { ...o, resourceUrl: resourceKey ? `https://${resourceKey}` : undefined };
    });
  }

  function serve(url: URL): Response | null {
    const key = `${url.host}${url.pathname}`;
    if (key.endsWith(CTYPE_SUFFIX)) return null; // never serve the sidecars
    let path: string;
    try {
      path = keyToPath(hostedDir, key);
    } catch {
      return null; // traversal or bad key → miss, never escapes the dir
    }
    if (!existsSync(path)) return null;
    const bytes = readFileSync(path);
    const contentType = existsSync(path + CTYPE_SUFFIX)
      ? readFileSync(path + CTYPE_SUFFIX, 'utf8')
      : 'application/octet-stream';
    return new Response(new Uint8Array(bytes), { status: 200, headers: untrustedHeaders(contentType) });
  }

  return { saveBytes, recordOriginal, list, serve };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/landing && bun test server/tests/originals-store.test.ts`
Expected: PASS — 8 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/server/webvh-host.ts apps/landing/server/originals-store.ts apps/landing/server/tests/originals-store.test.ts
git commit -m "feat(landing): durable filesystem originals-store (saveBytes/record/list/serve)"
```

---

## Task 2: Server routes + wiring (auth-gated `/api/originals*` + durable serve)

**Files:**
- Create: `apps/landing/server/originals-routes.ts`
- Modify: `apps/landing/server/index.ts` (`buildRoutes` gains `originals?`; dev block wires the store)
- Modify: `apps/landing/server/app.ts` (`buildFetch` gains `originals?`; dispatch host wildcard + serve fallback)
- Modify: `apps/landing/serve.ts` (wire `createOriginalsStore` + routes)
- Modify: `.gitignore` (ignore `.originals-data`)
- Test: `apps/landing/server/tests/originals-routes.test.ts`

**Interfaces:**
- Consumes: `OriginalsStore` from `./originals-store` (Task 1); `json`, `type Handler` from `./router`; `extractToken` from `./cookies`; `verifyToken` from `@originals/auth/server`; `createRateLimiter` from `./rate-limit`; `resolveClientIp`/`WebvhHostStore` context from `./app`.
- Produces:
  - `interface OriginalsRoutes { hostPut(req: Request, url: URL, clientIp: string): Promise<Response>; record: Handler; list: Handler; serve(url: URL): Response | null }`
  - `function createOriginalsRoutes(deps: { jwtSecret: string; store: OriginalsStore; now?: () => number }): OriginalsRoutes`
  - `buildRoutes` deps gains `originals?: OriginalsRoutes` — mounts `POST /api/originals` (→ `record`) and `GET /api/originals` (→ `list`).
  - `buildFetch` deps gains `originals?: OriginalsRoutes | null` — dispatches `PUT /api/originals/host/*` → `originals.hostPut(...)` (before the general `/api/*` branch) and falls back to `originals.serve(url)` after `hostStore.serve`.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/server/tests/originals-routes.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createOriginalsStore } from '../originals-store';
import { createOriginalsRoutes } from '../originals-routes';
import { buildFetch } from '../app';

const JWT = 'test-secret-at-least-32-chars-long!!';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'originals-routes-'));
  return createOriginalsStore({ dataDir: dir });
}
function cookieFor(sub: string): string {
  return serializeCookie(getAuthCookieConfig(signToken(sub, `${sub}@b.com`, undefined, { secret: JWT })));
}

describe('originals routes — auth gating', () => {
  test('GET/POST /api/originals + PUT host are 401 when anonymous', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    const listRes = await routes.list(new Request('http://h/api/originals'), new URL('http://h/api/originals'));
    expect(listRes.status).toBe(401);
    const recRes = await routes.record(
      new Request('http://h/api/originals', { method: 'POST', body: '{}' }),
      new URL('http://h/api/originals')
    );
    expect(recRes.status).toBe(401);
    const putUrl = new URL('http://h/api/originals/host/demo.example.com/studio/you/abc/did.jsonl');
    const putRes = await routes.hostPut(new Request(putUrl, { method: 'PUT', body: 'x' }), putUrl, '1.1.1.1');
    expect(putRes.status).toBe(401);
  });

  test('record then list under the authenticated sub', async () => {
    const routes = createOriginalsRoutes({ jwtSecret: JWT, store: tmpStore() });
    const cookie = cookieFor('sub-1');
    const rec = await routes.record(
      new Request('http://h/api/originals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ did: 'did:webvh:S:demo.example.com:studio:you:abc', title: 'Piece', resourceHash: 'deadbeef' }),
      }),
      new URL('http://h/api/originals')
    );
    expect(rec.status).toBe(200);

    const list = await routes.list(
      new Request('http://h/api/originals', { headers: { cookie } }),
      new URL('http://h/api/originals')
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { originals: Array<{ title: string }> };
    expect(body.originals.map((o) => o.title)).toEqual(['Piece']);
  });

  test('PUT host stores durably and buildFetch serves it at the resolver URL', async () => {
    const store = tmpStore();
    const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
    const fetchFn = buildFetch({ apiRoutes: null, hostStore: noopHostStore(), distDir: '/nonexistent/', originals });

    const key = 'demo.example.com/studio/you/abc/did.jsonl';
    const putRes = await fetchFn(
      new Request(`http://demo.local/api/originals/host/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/jsonl', cookie: cookieFor('sub-1') },
        body: '{"v":1}',
      })
    );
    expect(putRes.status).toBe(200);

    // Anyone GETting the resolver URL gets the durable object via the serve fallback.
    const getRes = await fetchFn(new Request('http://demo.example.com/studio/you/abc/did.jsonl'));
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe('{"v":1}');
    expect(getRes.headers.get('content-disposition')).toBe('attachment');
  });
});

// The ephemeral host store surface buildFetch also depends on — a no-op here.
function noopHostStore() {
  return {
    async handlePut() { return new Response(null, { status: 501 }); },
    read() { return new Response(null, { status: 404 }); },
    serve() { return null as Response | null; },
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/originals-routes.test.ts`
Expected: FAIL — `Cannot find module '../originals-routes'` (and `buildFetch` has no `originals` dep yet).

- [ ] **Step 3: Implement `apps/landing/server/originals-routes.ts`**

```typescript
/**
 * Auth-gated routes for durable per-user Originals.
 *
 *   PUT /api/originals/host/<encoded key>   store did:webvh log/cel/resource bytes
 *   POST /api/originals                     record an Original summary
 *   GET  /api/originals                     list the user's Originals
 *   serve(url)                              durable read at the resolver URL
 *
 * Every route requires a valid JWT (cookie or Bearer); the store is namespaced
 * by the JWT `sub`, so a user only ever writes/reads under their own account.
 */
import { verifyToken } from '@originals/auth/server';
import { json, type Handler } from './router';
import { extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';
import type { OriginalsStore } from './originals-store';

const HOST_PREFIX = '/api/originals/host/';

export interface OriginalsRoutes {
  hostPut(req: Request, url: URL, clientIp: string): Promise<Response>;
  record: Handler;
  list: Handler;
  serve(url: URL): Response | null;
}

export function createOriginalsRoutes(deps: {
  jwtSecret: string;
  store: OriginalsStore;
  now?: () => number;
}): OriginalsRoutes {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());
  const putLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

  /** Authenticated subOrgId, or null (→ 401). */
  function authSub(req: Request): string | null {
    const token = extractToken(req);
    if (!token) return null;
    try {
      return verifyToken(token, { secret: deps.jwtSecret }).sub;
    } catch {
      return null;
    }
  }

  function storeError(e: unknown): Response {
    const msg = (e as Error).message;
    if (msg === 'STORE_FULL') return json({ error: 'store_full' }, 507);
    if (msg === 'BAD_KEY') return json({ error: 'bad_key' }, 400);
    return json({ error: 'store_error', message: msg }, 500);
  }

  async function hostPut(req: Request, url: URL, clientIp: string): Promise<Response> {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    if (req.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);

    const rl = putLimiter.check(clientIp);
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) });
    }

    const key = decodeURIComponent(url.pathname.slice(HOST_PREFIX.length));
    if (!key) return json({ error: 'missing_key' }, 400);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const contentType = req.headers.get('content-type') ?? 'application/octet-stream';
    try {
      store.saveBytes(sub, key, bytes, contentType);
    } catch (e) {
      return storeError(e);
    }
    return json({ ok: true }, 200);
  }

  const record: Handler = async (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    const { did, title, resourceHash } = (await req.json().catch(() => ({}))) as {
      did?: string;
      title?: string;
      resourceHash?: string;
    };
    if (typeof did !== 'string' || typeof title !== 'string' || typeof resourceHash !== 'string') {
      return json({ error: 'bad_request' }, 400);
    }
    try {
      store.recordOriginal(sub, { did, title, resourceHash, createdAt: new Date(now()).toISOString() });
    } catch (e) {
      return storeError(e);
    }
    return json({ ok: true }, 200);
  };

  const list: Handler = (req) => {
    const sub = authSub(req);
    if (!sub) return json({ error: 'unauthorized' }, 401);
    return json({ originals: store.list(sub) });
  };

  return { hostPut, record, list, serve: (url) => store.serve(url) };
}
```

- [ ] **Step 4: Thread `originals` through `buildFetch` in `apps/landing/server/app.ts`**

Add the import at the top of `apps/landing/server/app.ts`:

```typescript
import type { OriginalsRoutes } from './originals-routes';
```

Extend the `buildFetch` deps type — replace:
```typescript
export function buildFetch(deps: {
  // The exact-match API route map (auth + optional /api/btc/*), or null when the
  // Turnkey/JWT env is absent — then /api/* returns a clean JSON 404 (never
  // SPA-fallback /api/* to index.html). The WebVH host store below is always on:
  // Track A (did:webvh hosting) must run without any secrets.
  apiRoutes: Record<string, Handler> | null;
  hostStore: WebvhHostStore;
  distDir: string;
}): (req: Request, server?: BunServerLike) => Promise<Response> {
  const { apiRoutes, hostStore, distDir } = deps;
```
with:
```typescript
export function buildFetch(deps: {
  // The exact-match API route map (auth + optional /api/btc/* + /api/originals),
  // or null when the Turnkey/JWT env is absent — then /api/* returns a clean JSON
  // 404 (never SPA-fallback /api/* to index.html). The WebVH host store below is
  // always on: Track A (did:webvh hosting) must run without any secrets.
  apiRoutes: Record<string, Handler> | null;
  hostStore: WebvhHostStore;
  distDir: string;
  // Durable per-user Originals (auth-gated). Present only when auth is configured.
  originals?: OriginalsRoutes | null;
}): (req: Request, server?: BunServerLike) => Promise<Response> {
  const { apiRoutes, hostStore, distDir, originals } = deps;
```

In the returned handler, add the durable host-write branch right after the existing `/api/host/` block and BEFORE the general `/api/` block:
```typescript
    // 1. WebVH host store (wildcard path — not expressible in the exact route
    // map). GET/HEAD read an object by key (adapter.get); PUT writes. Always
    // available (no auth required — Track A runs without secrets).
    if (path.startsWith('/api/host/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return hostStore.read(url);
      return hostStore.handlePut(req, url, resolveClientIp(req, server));
    }

    // 1b. Durable per-user Originals hosting (auth-gated). Same wildcard shape,
    // but persisted and namespaced by the JWT sub.
    if (originals && path.startsWith('/api/originals/host/')) {
      return originals.hostPut(req, url, resolveClientIp(req, server));
    }
```

And in the GET/HEAD serve block, add the durable fallback after the ephemeral one:
```typescript
    // 3. WebVH log/resource GETs served at the resolver's exact URLs.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = hostStore.serve(req, url);
      if (served) return served;
      const durable = originals?.serve(url);
      if (durable) return durable;
    }
```

- [ ] **Step 5: Run the routes test to verify it passes**

Run: `cd apps/landing && bun test server/tests/originals-routes.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 6: Mount the exact routes in `buildRoutes` (`apps/landing/server/index.ts`)**

Add the import near the other route imports:
```typescript
import type { OriginalsRoutes } from './originals-routes';
```

Extend `buildRoutes` — replace:
```typescript
export function buildRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
  bitcoin?: BitcoinRoutes;
}): Record<string, Handler> {
  const auth = createAuthRoutes(deps);
  const routes: Record<string, Handler> = {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': auth.sendOtp,
    'POST /api/auth/verify-otp': auth.verifyOtp,
    'GET /api/me': auth.me,
    'POST /api/auth/logout': auth.logout,
  };
  if (deps.bitcoin) {
    routes['POST /api/btc/funding'] = deps.bitcoin.funding;
    routes['POST /api/btc/sat'] = deps.bitcoin.sat;
    routes['POST /api/btc/fee'] = deps.bitcoin.fee;
    routes['POST /api/btc/broadcast'] = deps.bitcoin.broadcast;
  }
  return routes;
}
```
with:
```typescript
export function buildRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
  bitcoin?: BitcoinRoutes;
  originals?: OriginalsRoutes;
}): Record<string, Handler> {
  const auth = createAuthRoutes(deps);
  const routes: Record<string, Handler> = {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': auth.sendOtp,
    'POST /api/auth/verify-otp': auth.verifyOtp,
    'GET /api/me': auth.me,
    'POST /api/auth/logout': auth.logout,
  };
  if (deps.bitcoin) {
    routes['POST /api/btc/funding'] = deps.bitcoin.funding;
    routes['POST /api/btc/sat'] = deps.bitcoin.sat;
    routes['POST /api/btc/fee'] = deps.bitcoin.fee;
    routes['POST /api/btc/broadcast'] = deps.bitcoin.broadcast;
  }
  if (deps.originals) {
    routes['POST /api/originals'] = deps.originals.record;
    routes['GET /api/originals'] = deps.originals.list;
  }
  return routes;
}
```

Wire the store into the dev block (`if (import.meta.main)`) — replace:
```typescript
  const apiRoutes = buildRoutes({
    turnkey: getTurnkey(),
    sessions: createInMemorySessionStorage(),
    jwtSecret,
  });
  const hostStore = createWebvhHostStore();
  const distDir = new URL('../dist/', import.meta.url).pathname;
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8787),
    fetch: buildFetch({ apiRoutes, hostStore, distDir }),
  });
```
with:
```typescript
  const originalsStore = createOriginalsStore({
    dataDir: process.env.ORIGINALS_DATA_DIR ?? './.originals-data',
  });
  const originals = createOriginalsRoutes({ jwtSecret, store: originalsStore });
  const apiRoutes = buildRoutes({
    turnkey: getTurnkey(),
    sessions: createInMemorySessionStorage(),
    jwtSecret,
    originals,
  });
  const hostStore = createWebvhHostStore();
  const distDir = new URL('../dist/', import.meta.url).pathname;
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8787),
    fetch: buildFetch({ apiRoutes, hostStore, distDir, originals }),
  });
```

Add the two imports the dev block now needs (near the top of `index.ts`):
```typescript
import { createOriginalsStore } from './originals-store';
import { createOriginalsRoutes } from './originals-routes';
```

- [ ] **Step 7: Wire the store into the prod entry `apps/landing/serve.ts`**

Add imports near the other `./server/*` imports:
```typescript
import { createOriginalsStore } from './server/originals-store';
import { createOriginalsRoutes, type OriginalsRoutes } from './server/originals-routes';
```

Add the store next to `hostStore` — after:
```typescript
const hostStore = createWebvhHostStore();
```
insert:
```typescript
const originalsStore = createOriginalsStore({
  dataDir: process.env.ORIGINALS_DATA_DIR ?? './.originals-data',
});
```

Make `buildApiRoutes` also build + mount the originals routes and hand them back. Replace the `buildApiRoutes` signature line and its `return`:
```typescript
function buildApiRoutes(): Record<string, Handler> | null {
```
with:
```typescript
function buildApiRoutes(): { routes: Record<string, Handler>; originals: OriginalsRoutes } | null {
```
Replace the final `return buildRoutes(...)` line:
```typescript
  return buildRoutes({ turnkey, sessions: createInMemorySessionStorage(), jwtSecret, bitcoin });
```
with:
```typescript
  const originals = createOriginalsRoutes({ jwtSecret, store: originalsStore });
  return {
    routes: buildRoutes({ turnkey, sessions: createInMemorySessionStorage(), jwtSecret, bitcoin, originals }),
    originals,
  };
```
And `return null;` inside `buildApiRoutes` stays as-is (auth unconfigured → no originals routes either).

Finally, thread it into `Bun.serve`. Replace:
```typescript
const apiRoutes = buildApiRoutes();

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: buildFetch({ apiRoutes, hostStore, distDir: DIST }),
});

console.log(
  `[landing] serving ${DIST} on http://0.0.0.0:${server.port} (auth API: ${apiRoutes ? 'enabled' : 'static-only'})`
);
```
with:
```typescript
const api = buildApiRoutes();

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: buildFetch({
    apiRoutes: api?.routes ?? null,
    hostStore,
    distDir: DIST,
    originals: api?.originals ?? null,
  }),
});

console.log(
  `[landing] serving ${DIST} on http://0.0.0.0:${server.port} (auth API: ${api ? 'enabled' : 'static-only'})`
);
```

- [ ] **Step 8: Ignore the dev data dir in `.gitignore`**

Append to `/Users/brian/Projects/onionoriginals/sdk/.gitignore` (root), under a new heading:
```
# Durable Originals store (dev default; prod uses a Railway volume at ORIGINALS_DATA_DIR)
.originals-data/
```

- [ ] **Step 9: Full server suite (no regressions)**

Run: `cd apps/landing && bun test server/tests/`
Expected: PASS — all server suites green (existing app/webvh-host/bitcoin/router/etc. plus the two new suites).

- [ ] **Step 10: Commit**

```bash
git add apps/landing/server/originals-routes.ts apps/landing/server/app.ts apps/landing/server/index.ts apps/landing/serve.ts apps/landing/server/tests/originals-routes.test.ts .gitignore
git commit -m "feat(landing): auth-gated /api/originals routes + durable serve wiring"
```

---

## Task 3: `DurableHostingStorageAdapter` (browser adapter over `/api/originals/host/*`)

**Files:**
- Create: `apps/landing/src/sdk/durable-hosting-adapter.ts`
- Test: `apps/landing/src/sdk/durable-hosting-adapter.test.ts`

**Interfaces:**
- Consumes: `globalThis.fetch`.
- Produces: `class DurableHostingStorageAdapter` (SDK StorageAdapter interface A) — same `put`/`get` surface as `HttpHostingStorageAdapter`, but the endpoint is `/api/originals/host/<encoded key>` and requests send `credentials: 'same-origin'` (the auth cookie). Constructor `{ baseUrl?: string; fetchImpl?: typeof fetch }` (`baseUrl` default `''`).

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/sdk/durable-hosting-adapter.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { DurableHostingStorageAdapter } from './durable-hosting-adapter';

function mockFetch() {
  const calls: Array<{ method: string; url: string; credentials?: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url, credentials: init?.credentials });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('DurableHostingStorageAdapter', () => {
  test('put targets /api/originals/host/<encoded key> with same-origin credentials', async () => {
    const { impl, calls } = mockFetch();
    const adapter = new DurableHostingStorageAdapter({ baseUrl: '', fetchImpl: impl });
    const key = 'demo.example.com/studio/you/abc/did.jsonl';
    const url = await adapter.put(key, '{"v":1}', { contentType: 'application/jsonl' });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('/api/originals/host/' + encodeURIComponent(key));
    expect(calls[0].credentials).toBe('same-origin');
    expect(url).toBe('https://' + key);
  });

  test('put throws on a non-ok response', async () => {
    const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const adapter = new DurableHostingStorageAdapter({ baseUrl: '', fetchImpl: failing });
    await expect(adapter.put('k', 'x', { contentType: 'text/plain' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/durable-hosting-adapter.test.ts`
Expected: FAIL — `Cannot find module './durable-hosting-adapter'`.

- [ ] **Step 3: Implement `apps/landing/src/sdk/durable-hosting-adapter.ts`**

```typescript
/**
 * SDK StorageAdapter (interface A: put/get) for a SIGNED-IN user's durable
 * Originals. Mirrors http-hosting-adapter.ts, but forwards writes to
 * PUT /api/originals/host/<encoded key> with the auth cookie (credentials:
 * 'same-origin') so the server persists them under the user's JWT sub. The
 * returned URL is the resolvable HTTPS URL for that key.
 */
function toBytes(data: Buffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

export class DurableHostingStorageAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts?.baseUrl ?? '';
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private endpoint(objectKey: string): string {
    return `${this.baseUrl}/api/originals/host/${encodeURIComponent(objectKey)}`;
  }

  async put(
    objectKey: string,
    data: Buffer | Uint8Array | string,
    options?: { contentType?: string; cacheControl?: string }
  ): Promise<string> {
    const bytes = toBytes(data);
    const res = await this.fetchImpl(this.endpoint(objectKey), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': options?.contentType ?? 'application/octet-stream' },
      body: bytes.slice().buffer,
    });
    if (!res.ok) {
      throw new Error(`DurableHostingStorageAdapter.put failed: ${res.status} for ${objectKey}`);
    }
    return `https://${objectKey}`;
  }

  async get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null> {
    const res = await this.fetchImpl(this.endpoint(objectKey), {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`DurableHostingStorageAdapter.get failed: ${res.status} for ${objectKey}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { content: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/durable-hosting-adapter.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/sdk/durable-hosting-adapter.ts apps/landing/src/sdk/durable-hosting-adapter.test.ts
git commit -m "feat(landing): DurableHostingStorageAdapter over PUT/GET /api/originals/host/*"
```

---

## Task 4: Engine authed publish (durable adapter + summary POST)

**Files:**
- Modify: `apps/landing/src/sdk/engine.ts` (constructor opt, adapter selection, store title/hash, POST after publish)
- Modify: `apps/landing/src/components/Demo.tsx` (construct the engine `authed` from `isAuthenticated`)
- Test: `apps/landing/src/sdk/engine.durable-publish.test.ts`

**Interfaces:**
- Consumes: `DurableHostingStorageAdapter` from `./durable-hosting-adapter` (Task 3); `createOriginalsStore` + `createOriginalsRoutes` + `buildFetch` (Task 1/2, test only).
- Produces:
  - `DemoEngine` constructor gains `opts?: { authed?: boolean }`. When `authed`, `storageAdapter: new DurableHostingStorageAdapter()`; otherwise the current `HttpHostingStorageAdapter` (or the testnet path) — unchanged.
  - After publish + resolve, when `authed`, the engine POSTs `POST /api/originals` (`credentials: 'same-origin'`) with `{ did: assetWebvhDid, title, resourceHash }`. `title` is captured from `create()`; `resourceHash` is the artwork resource hash (`asset.resources[0].hash`).

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/sdk/engine.durable-publish.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { DemoEngine } from './engine';
import { createOriginalsStore } from '../../server/originals-store';
import { createOriginalsRoutes } from '../../server/originals-routes';
import { createWebvhHostStore } from '../../server/webvh-host';
import { buildFetch } from '../../server/app';

const JWT = 'test-secret-at-least-32-chars-long!!';
const HOST = 'demo.test';

// Route the browser's durable PUTs, the summary POST, AND the resolver's https
// GETs through one in-process server (buildFetch) with a real durable store.
function installServerFetch(store: ReturnType<typeof createOriginalsStore>) {
  const originals = createOriginalsRoutes({ jwtSecret: JWT, store });
  const apiRoutes = { 'POST /api/originals': originals.record, 'GET /api/originals': originals.list } as Record<
    string,
    (req: Request, url: URL) => Response | Promise<Response>
  >;
  const fetchFn = buildFetch({ apiRoutes, hostStore: createWebvhHostStore(), distDir: '/nonexistent/', originals });
  const cookie = getAuthCookieConfig(signToken('sub-1', 's@b.com', undefined, { secret: JWT }));
  const cookieHeader = `${cookie.name}=${cookie.value}`;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const url = new URL(raw, `http://${HOST}`);
    const headers = new Headers(init?.headers as HeadersInit);
    headers.set('cookie', cookieHeader); // the browser would attach the auth cookie
    return fetchFn(new Request(url, { ...init, headers }));
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = real; };
}

describe('authed durable publish', () => {
  let restore: () => void;
  let store: ReturnType<typeof createOriginalsStore>;

  beforeEach(() => {
    (import.meta as unknown as { env: Record<string, string> }).env ??= {};
    (import.meta as unknown as { env: Record<string, string> }).env.VITE_WEBVH_HOST = HOST;
    store = createOriginalsStore({ dataDir: mkdtempSync(join(tmpdir(), 'engine-durable-')) });
    restore = installServerFetch(store);
  });
  afterEach(() => restore());

  test('authed publish hosts durably and records a summary', async () => {
    const engine = new DemoEngine({ authed: true });
    await engine.create('Durable Piece', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const state = await engine.publish();

    expect(state.layer).toBe('did:webvh');
    // The summary was recorded under the authed sub.
    const list = store.list('sub-1');
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('Durable Piece');
    expect(list[0].did).toBe(state.webvhDid);
    // The did log is durably served at its resolver URL.
    const served = store.serve(new URL(state.webvhLogUrl!.replace('https://', 'http://')));
    expect(served).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/engine.durable-publish.test.ts`
Expected: FAIL — `DemoEngine` ignores `{ authed: true }`, uses the ephemeral adapter, and never POSTs a summary, so `store.list('sub-1')` is empty.

- [ ] **Step 3: Add the durable-adapter import + constructor opt in `apps/landing/src/sdk/engine.ts`**

Add to the imports (below the existing `HttpHostingStorageAdapter` import):
```typescript
import { DurableHostingStorageAdapter } from './durable-hosting-adapter';
```

Add two private fields next to `webvhResolved`:
```typescript
  private webvhLogUrl: string | null = null;
  private webvhResolved = false;
```
becomes:
```typescript
  private webvhLogUrl: string | null = null;
  private webvhResolved = false;
  private readonly authed: boolean;
  private assetTitle = '';
  private assetResourceHash = '';
```

Change the constructor signature + capture the flag — replace:
```typescript
  constructor() {
    // Deliberately public and permanent: lets anyone (including skeptics)
```
with:
```typescript
  constructor(opts?: { authed?: boolean }) {
    this.authed = opts?.authed ?? false;
    // Deliberately public and permanent: lets anyone (including skeptics)
```

Select the adapter — replace:
```typescript
      // Real HTTP hosting at this origin — the SDK's did:webvh log becomes
      // resolvable over HTTP(S) (see http-hosting-adapter.ts).
      storageAdapter: new HttpHostingStorageAdapter(),
```
with:
```typescript
      // Signed-in users host DURABLY (persisted under their account, PUT
      // /api/originals/host/*); anonymous users keep the ephemeral TTL host
      // (PUT /api/host/*). Both make the did:webvh log resolvable over HTTP(S).
      storageAdapter: this.authed
        ? new DurableHostingStorageAdapter()
        : new HttpHostingStorageAdapter(),
```

- [ ] **Step 4: Capture the title + resource hash in `create()`**

In `create()`, immediately after `this.asset = asset;`, add:
```typescript
    this.asset = asset;
    this.assetTitle = title;
    this.assetResourceHash = svgHash;
```

- [ ] **Step 5: POST the summary after publish + resolve (authed only)**

In `publish()`, replace the tail:
```typescript
    this.webvhLogUrl = logUrl;
    this.webvhResolved = resolved;
    this.emit(
      'did:webvh:resolved',
      resolved
        ? `did:webvh log resolved over HTTPS — ${logUrl}`
        : `did:webvh log hosted at ${logUrl} (resolves over HTTPS in production)`,
      { logUrl, resolved, doc: resolvedDoc }
    );

    return this.snapshot();
  }
```
with:
```typescript
    this.webvhLogUrl = logUrl;
    this.webvhResolved = resolved;
    this.emit(
      'did:webvh:resolved',
      resolved
        ? `did:webvh log resolved over HTTPS — ${logUrl}`
        : `did:webvh log hosted at ${logUrl} (resolves over HTTPS in production)`,
      { logUrl, resolved, doc: resolvedDoc }
    );

    // Signed-in: record a durable summary under the user's account so it shows
    // up on /me. Best-effort — a failure must not break the publish UX.
    if (this.authed && assetWebvhDid) {
      try {
        const res = await fetch('/api/originals', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            did: assetWebvhDid,
            title: this.assetTitle,
            resourceHash: this.assetResourceHash,
          }),
        });
        if (!res.ok) log('originals:record-failed', res.status);
      } catch (err) {
        log('originals:record-failed', err);
      }
    }

    return this.snapshot();
  }
```

- [ ] **Step 6: Construct the engine `authed` from auth state in `apps/landing/src/components/Demo.tsx`**

`useEngine()` needs the current auth flag. Change its signature — replace:
```typescript
function useEngine() {
  const engineRef = useRef<DemoEngine | null>(null);
  const loading = useRef<Promise<DemoEngine> | null>(null);

  const getEngine = useCallback(async (): Promise<DemoEngine> => {
    if (engineRef.current) return engineRef.current;
    loading.current ??= import('../sdk/engine').then(({ DemoEngine }) => {
      // The engine registers itself as window.__originalsDemo so skeptics can
      // inspect it from the devtools console.
      const engine = new DemoEngine();
      engineRef.current = engine;
      return engine;
    });
    return loading.current;
  }, []);
```
with:
```typescript
function useEngine(authed: boolean) {
  const engineRef = useRef<DemoEngine | null>(null);
  const loading = useRef<Promise<DemoEngine> | null>(null);

  const getEngine = useCallback(async (): Promise<DemoEngine> => {
    if (engineRef.current) return engineRef.current;
    loading.current ??= import('../sdk/engine').then(({ DemoEngine }) => {
      // The engine registers itself as window.__originalsDemo so skeptics can
      // inspect it from the devtools console. Signed-in ⇒ durable hosting.
      const engine = new DemoEngine({ authed });
      engineRef.current = engine;
      return engine;
    });
    return loading.current;
  }, [authed]);
```

Update the call site — replace:
```typescript
  const { getEngine, discardEngine } = useEngine();
```
with:
```typescript
  const { getEngine, discardEngine } = useEngine(isAuthenticated);
```
(`isAuthenticated` is already destructured from `useAuth()` at the top of `Demo()`.)

- [ ] **Step 7: Run the integration test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/engine.durable-publish.test.ts`
Expected: PASS — 1 test passes.

- [ ] **Step 8: Confirm the anonymous path is unregressed**

Run: `cd apps/landing && bun test src/sdk/engine.publish-resolve.test.ts src/sdk/engine.summary.test.ts`
Expected: PASS — the anonymous publish→resolve and summary suites stay green (they construct `new DemoEngine()` with no opts → ephemeral adapter, no POST).

- [ ] **Step 9: Commit**

```bash
git add apps/landing/src/sdk/engine.ts apps/landing/src/components/Demo.tsx apps/landing/src/sdk/engine.durable-publish.test.ts
git commit -m "feat(landing): authed engine hosts durably + records an Original summary"
```

---

## Task 5: `/me` "Your Originals" page + client routing

**Files:**
- Create: `apps/landing/src/router.tsx`
- Create: `apps/landing/src/pages/YourOriginals.tsx`
- Create: `apps/landing/src/pages/your-originals.css`
- Modify: `apps/landing/src/content.ts` (add a `yourOriginals` block)
- Modify: `apps/landing/src/App.tsx` (route `/me`)
- Modify: `apps/landing/src/components/Nav.tsx` (add a "Your Originals" link when authenticated)
- Test: `apps/landing/src/router.test.ts`, `apps/landing/src/pages/your-originals-content.test.ts`, `apps/landing/src/pages/your-originals-list.test.ts`

**Interfaces:**
- Consumes: `useAuth` from `../auth/useAuth`; `yourOriginals` from `../content`.
- Produces:
  - `router.tsx`: `function useLocationPath(): string` (re-renders on `popstate` + `navigate`) and `function navigate(path: string): void` (pushState + notify).
  - `YourOriginals.tsx`: `function YourOriginals(): JSX.Element` (auth-gated page) and a pure, testable `function originalsView(input: { authenticated: boolean; originals: OriginalRow[] }): { mode: 'signed-out' | 'empty' | 'list'; rows: OriginalRow[] }`.
  - `interface OriginalRow { did: string; title: string; resourceHash: string; createdAt: string; resourceUrl?: string }`.

- [ ] **Step 1: Write the failing router test**

Create `apps/landing/src/router.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { routeForPath } from './router';

describe('routeForPath', () => {
  test('/ → landing', () => {
    expect(routeForPath('/')).toBe('landing');
  });
  test('/me → your-originals', () => {
    expect(routeForPath('/me')).toBe('your-originals');
  });
  test('unknown path → landing (SPA fallback)', () => {
    expect(routeForPath('/anything/else')).toBe('landing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/router.test.ts`
Expected: FAIL — `Cannot find module './router'`.

- [ ] **Step 3: Implement `apps/landing/src/router.tsx`**

```typescript
/**
 * Minimal client-side routing — no react-router. Two views: the landing page
 * ('/') and Your Originals ('/me'). navigate() pushes history and notifies
 * subscribers; useLocationPath() re-renders on navigate + browser back/forward.
 */
import { useEffect, useState } from 'react';

export type RouteName = 'landing' | 'your-originals';

export function routeForPath(pathname: string): RouteName {
  return pathname === '/me' ? 'your-originals' : 'landing';
}

const NAV_EVENT = 'originals:navigate';

export function navigate(path: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export function useLocationPath(): string {
  const [path, setPath] = useState(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    window.addEventListener(NAV_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAV_EVENT, update);
    };
  }, []);
  return path;
}
```

- [ ] **Step 4: Run the router test to verify it passes**

Run: `cd apps/landing && bun test src/router.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Write the failing content test**

Create `apps/landing/src/pages/your-originals-content.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { yourOriginals } from '../content';

describe('yourOriginals copy', () => {
  test('has the strings the page renders', () => {
    expect(yourOriginals).toBeDefined();
    expect(typeof yourOriginals.heading).toBe('string');
    expect(yourOriginals.heading.length).toBeGreaterThan(0);
    expect(typeof yourOriginals.signedOut).toBe('string');
    expect(typeof yourOriginals.emptyTitle).toBe('string');
    expect(typeof yourOriginals.emptyCta).toBe('string');
    expect(typeof yourOriginals.resolvedBadge).toBe('string');
    expect(typeof yourOriginals.pendingBadge).toBe('string');
    expect(typeof yourOriginals.openLog).toBe('string');
    expect(typeof yourOriginals.navLabel).toBe('string');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/landing && bun test src/pages/your-originals-content.test.ts`
Expected: FAIL — `yourOriginals` is `undefined`.

- [ ] **Step 7: Add the `yourOriginals` copy block to `apps/landing/src/content.ts`**

After the `demo` export's closing `};` (and before `export const realExample`), add:
```typescript
export const yourOriginals = {
  navLabel: 'Your Originals',
  heading: 'Your Originals',
  subhead:
    'Every piece you’ve created and published lives here — each a real, resolvable did:webvh with a signed version history hosted at this origin.',
  signedOut: 'Sign in to see the Originals saved to your account.',
  emptyTitle: 'No Originals yet.',
  emptyBody: 'Create and publish your first piece in the live demo — signed in, it’s saved right here.',
  emptyCta: 'Create your first Original',
  resolvedBadge: 'resolved ✓',
  pendingBadge: 'resolves in production',
  openLog: 'Open the signed DID log',
  createdLabel: 'Created',
};
```

- [ ] **Step 8: Run the content test to verify it passes**

Run: `cd apps/landing && bun test src/pages/your-originals-content.test.ts`
Expected: PASS — 1 test passes.

- [ ] **Step 9: Write the failing list-logic test**

Create `apps/landing/src/pages/your-originals-list.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { originalsView, type OriginalRow } from './YourOriginals';

const rows: OriginalRow[] = [
  {
    did: 'did:webvh:S:demo.example.com:studio:you:abc',
    title: 'First',
    resourceHash: 'deadbeef',
    createdAt: '2026-07-21T00:00:00.000Z',
    resourceUrl: 'https://demo.example.com/studio/you/abc/resources/zR1',
  },
];

describe('originalsView', () => {
  test('signed-out mode when not authenticated', () => {
    expect(originalsView({ authenticated: false, originals: [] }).mode).toBe('signed-out');
  });
  test('empty mode when authenticated with no originals', () => {
    expect(originalsView({ authenticated: true, originals: [] }).mode).toBe('empty');
  });
  test('list mode returns the rows when authenticated with originals', () => {
    const view = originalsView({ authenticated: true, originals: rows });
    expect(view.mode).toBe('list');
    expect(view.rows).toEqual(rows);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd apps/landing && bun test src/pages/your-originals-list.test.ts`
Expected: FAIL — `Cannot find module './YourOriginals'`.

- [ ] **Step 11: Implement `apps/landing/src/pages/YourOriginals.tsx`**

```typescript
/**
 * The /me "Your Originals" page. Auth-gated: signed-out users get a prompt;
 * signed-in users see their durable did:webvh Originals (artwork thumbnail,
 * title, did with a live "resolved ✓", open-log link, created date). Empty
 * state links back to the demo.
 */
import { useEffect, useState } from 'react';
import { yourOriginals } from '../content';
import { useAuth } from '../auth/useAuth';
import { navigate } from '../router';
import './your-originals.css';

export interface OriginalRow {
  did: string;
  title: string;
  resourceHash: string;
  createdAt: string;
  resourceUrl?: string;
}

// Pure view selector — testable without a DOM.
export function originalsView(input: { authenticated: boolean; originals: OriginalRow[] }): {
  mode: 'signed-out' | 'empty' | 'list';
  rows: OriginalRow[];
} {
  if (!input.authenticated) return { mode: 'signed-out', rows: [] };
  if (input.originals.length === 0) return { mode: 'empty', rows: [] };
  return { mode: 'list', rows: input.originals };
}

async function fetchOriginals(): Promise<OriginalRow[]> {
  const res = await fetch('/api/originals', { credentials: 'same-origin' });
  if (!res.ok) return [];
  const body = (await res.json()) as { originals?: OriginalRow[] };
  return body.originals ?? [];
}

// Best-effort live resolution proof (production only — the resolver forces
// https, so a dev http origin returns false; the row still renders).
async function resolveLive(did: string): Promise<boolean> {
  try {
    const { OriginalsSDK, OrdMockProvider } = await import('@originals/sdk');
    const { HttpHostingStorageAdapter } = await import('../sdk/http-hosting-adapter');
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
      storageAdapter: new HttpHostingStorageAdapter(),
      enableLogging: false,
    } as unknown as Parameters<typeof OriginalsSDK.create>[0]);
    return !!(await sdk.did.resolveDID(did, { skipCache: true } as never));
  } catch {
    return false;
  }
}

function didLogUrl(did: string): string {
  const parts = did.split(':'); // did:webvh:<SCID>:<host>[:<seg>…]
  const host = decodeURIComponent(parts[3] ?? '');
  const segs = parts.slice(4).map((s) => decodeURIComponent(s));
  return segs.length ? `https://${host}/${segs.join('/')}/did.jsonl` : `https://${host}/.well-known/did.jsonl`;
}

export function YourOriginals() {
  const { isAuthenticated } = useAuth();
  const [originals, setOriginals] = useState<OriginalRow[]>([]);
  const [resolved, setResolved] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isAuthenticated) return;
    let live = true;
    fetchOriginals().then((rows) => {
      if (!live) return;
      setOriginals(rows);
      rows.forEach((r) => resolveLive(r.did).then((ok) => live && setResolved((m) => ({ ...m, [r.did]: ok }))));
    });
    return () => { live = false; };
  }, [isAuthenticated]);

  const view = originalsView({ authenticated: isAuthenticated, originals });

  return (
    <main className="section your-originals">
      <div className="container">
        <p className="eyebrow">{yourOriginals.navLabel}</p>
        <h1>{yourOriginals.heading}</h1>
        <p className="your-originals-sub">{yourOriginals.subhead}</p>

        {view.mode === 'signed-out' && <p className="your-originals-note">{yourOriginals.signedOut}</p>}

        {view.mode === 'empty' && (
          <div className="your-originals-empty">
            <p className="your-originals-empty-title">{yourOriginals.emptyTitle}</p>
            <p>{yourOriginals.emptyBody}</p>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
              {yourOriginals.emptyCta}
            </button>
          </div>
        )}

        {view.mode === 'list' && (
          <ul className="your-originals-list">
            {view.rows.map((row) => {
              const logUrl = didLogUrl(row.did);
              const ok = resolved[row.did];
              return (
                <li key={row.did} className="your-original">
                  {row.resourceUrl ? (
                    <img className="your-original-thumb" src={row.resourceUrl} alt={`Artwork for “${row.title}”`} />
                  ) : (
                    <span className="your-original-thumb your-original-thumb-empty" aria-hidden="true" />
                  )}
                  <div className="your-original-body">
                    <h2>{row.title}</h2>
                    <div className="your-original-did">
                      <code title={row.did}>{row.did}</code>
                      <span className="your-original-badge" data-ok={ok || undefined}>
                        {ok ? yourOriginals.resolvedBadge : yourOriginals.pendingBadge}
                      </span>
                    </div>
                    <a href={logUrl} target="_blank" rel="noreferrer" className="your-original-log">
                      {yourOriginals.openLog}
                    </a>
                    <p className="your-original-created">
                      {yourOriginals.createdLabel} {row.createdAt.slice(0, 10)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 12: Add minimal styles `apps/landing/src/pages/your-originals.css`**

```css
.your-originals { padding-top: 6rem; }
.your-originals-sub { max-width: 46rem; color: var(--text-secondary, #666); }
.your-originals-note { margin-top: 1.5rem; }
.your-originals-empty { margin-top: 2rem; display: grid; gap: 0.75rem; justify-items: start; }
.your-originals-empty-title { font-weight: 600; font-size: 1.1rem; }
.your-originals-list { list-style: none; padding: 0; margin: 2rem 0 0; display: grid; gap: 1rem; }
.your-original {
  display: flex; gap: 1rem; align-items: flex-start;
  padding: 1rem; border: 1px solid var(--border, rgba(128, 128, 128, 0.25)); border-radius: 12px;
}
.your-original-thumb { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; flex: none; background: color-mix(in srgb, var(--webvh) 8%, transparent); }
.your-original-thumb-empty { display: inline-block; }
.your-original-body { display: grid; gap: 0.3rem; min-width: 0; }
.your-original-body h2 { margin: 0; font-size: 1rem; }
.your-original-did { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.your-original-did code { font-size: 0.72rem; word-break: break-all; color: var(--webvh); }
.your-original-badge {
  font-size: 0.68rem; font-weight: 600; padding: 0.12rem 0.45rem; border-radius: 999px;
  color: var(--text-tertiary, #888); background: color-mix(in srgb, currentColor 12%, transparent);
}
.your-original-badge[data-ok] { color: var(--ok, #1a8f4a); }
.your-original-log { font-size: 0.82rem; }
.your-original-created { font-size: 0.75rem; color: var(--text-tertiary, #888); margin: 0; }
```

- [ ] **Step 13: Run the list-logic test to verify it passes**

Run: `cd apps/landing && bun test src/pages/your-originals-list.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 14: Route `/me` in `apps/landing/src/App.tsx`**

Replace the whole `App()` function:
```typescript
export function App() {
  if (new URLSearchParams(location.search).has('smoke')) {
    return <SmokeTest />;
  }
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Why />
        <Demo />
        <RealExample />
        <Protocol />
        <Developers />
      </main>
      <Footer />
    </>
  );
}
```
with:
```typescript
export function App() {
  if (new URLSearchParams(location.search).has('smoke')) {
    return <SmokeTest />;
  }
  return <RoutedApp />;
}

function RoutedApp() {
  const path = useLocationPath();
  return (
    <>
      <Nav />
      {routeForPath(path) === 'your-originals' ? (
        <YourOriginals />
      ) : (
        <main>
          <Hero />
          <Why />
          <Demo />
          <RealExample />
          <Protocol />
          <Developers />
        </main>
      )}
      <Footer />
    </>
  );
}
```

Add the imports at the top of `App.tsx` (below the existing component imports):
```typescript
import { useLocationPath, routeForPath } from './router';
import { YourOriginals } from './pages/YourOriginals';
```

- [ ] **Step 15: Add the "Your Originals" nav link (signed-in only) in `apps/landing/src/components/Nav.tsx`**

Add the imports at the top:
```typescript
import { yourOriginals } from '../content';
import { navigate } from '../router';
```

In the desktop `.nav-actions` block, add the link just before the auth `{isAuthenticated ? (...)}` conditional — insert:
```tsx
          {isAuthenticated && (
            <a
              className="nav-your-originals"
              href="/me"
              onClick={(e) => {
                e.preventDefault();
                navigate('/me');
              }}
            >
              {yourOriginals.navLabel}
            </a>
          )}
```

- [ ] **Step 16: Full page/router/content sweep (no regressions)**

Run: `cd apps/landing && bun test src/router.test.ts src/pages/your-originals-content.test.ts src/pages/your-originals-list.test.ts`
Expected: PASS — all three suites green (3 + 1 + 3 tests).

- [ ] **Step 17: Commit**

```bash
git add apps/landing/src/router.tsx apps/landing/src/router.test.ts apps/landing/src/pages/YourOriginals.tsx apps/landing/src/pages/your-originals.css apps/landing/src/pages/your-originals-content.test.ts apps/landing/src/pages/your-originals-list.test.ts apps/landing/src/content.ts apps/landing/src/App.tsx apps/landing/src/components/Nav.tsx
git commit -m "feat(landing): /me Your Originals page + hand-rolled routing + nav link"
```

---

## Task 6: Inscribe step becomes "Coming soon"

**Files:**
- Modify: `apps/landing/src/content.ts` (`demo.steps[2]` copy + a `demo.comingSoon` string)
- Modify: `apps/landing/src/components/Demo.tsx` (disabled coming-soon state; no `inscribe()` call when not testnet-enabled)
- Test: `apps/landing/src/components/demo-coming-soon-content.test.ts`

**Interfaces:**
- Consumes: `demo` from `../content`.
- Produces: no new exports; the inscribe step (index 2) renders a disabled "Coming soon" button and the published-state note shows `demo.comingSoon` when NOT `btcTestnetEnabled()`. The `btcTestnetEnabled()` real path and the `?smoke=1` harness's direct `engine.inscribe(...)` call are untouched.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/components/demo-coming-soon-content.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { demo } from '../content';

describe('inscribe coming-soon copy', () => {
  test('has a comingSoon string', () => {
    expect(typeof demo.comingSoon).toBe('string');
    expect(demo.comingSoon.length).toBeGreaterThan(0);
  });
  test('the inscribe step (steps[2]) reads as coming soon, not a live inscription', () => {
    expect(demo.steps[2].description.toLowerCase()).toContain('coming');
    expect(demo.steps[2].description).not.toContain('Runs the commit/reveal inscription flow');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/components/demo-coming-soon-content.test.ts`
Expected: FAIL — `demo.comingSoon` is `undefined` and `steps[2].description` still says "Runs the commit/reveal inscription flow…".

- [ ] **Step 3: Update the inscribe step copy + add `comingSoon` in `apps/landing/src/content.ts`**

Replace the inscribe step's `description`:
```typescript
      description:
        'Runs the commit/reveal inscription flow and binds the asset to a specific satoshi as did:btco.'
```
with:
```typescript
      description:
        'Coming soon: inscribe the published Original onto a satoshi as did:btco — real Bitcoin inscription lands once testnet4 ordinals support ships.'
```

Add a `comingSoon` string to the `demo` object — replace:
```typescript
  reset: 'Start over with a new asset'
};
```
with:
```typescript
  comingSoon: 'Coming soon — inscribing on Bitcoin (did:btco) is not enabled yet. Your Original is already real and resolvable as did:webvh.',
  reset: 'Start over with a new asset'
};
```

- [ ] **Step 4: Render the coming-soon state in `apps/landing/src/components/Demo.tsx`**

Compute the coming-soon flag inside the step-render map. Replace the button block:
```tsx
                          {state !== 'done' && (
                            <button
                              type="button"
                              className="btn btn-primary demo-step-btn"
                              disabled={
                                (state !== 'ready' && state !== 'busy') ||
                                (i === 0 && title.trim().length === 0)
                              }
                              data-busy={state === 'busy' || undefined}
                              onClick={stepActions[i]}
                            >
                              {state === 'busy' ? (
                                <>
                                  <span className="demo-spinner" aria-hidden="true" />
                                  {s.pending}
                                </>
                              ) : (
                                s.action
                              )}
                            </button>
                          )}
```
with:
```tsx
                          {state !== 'done' &&
                            (i === 2 && !testnet ? (
                              // did:btco inscription is not live yet — disabled,
                              // never calls engine.inscribe(). The gated testnet4
                              // path (testnet === true) is unchanged.
                              <button type="button" className="btn demo-step-btn" disabled>
                                {demo.comingSoon}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary demo-step-btn"
                                disabled={
                                  (state !== 'ready' && state !== 'busy') ||
                                  (i === 0 && title.trim().length === 0)
                                }
                                data-busy={state === 'busy' || undefined}
                                onClick={stepActions[i]}
                              >
                                {state === 'busy' ? (
                                  <>
                                    <span className="demo-spinner" aria-hidden="true" />
                                    {s.pending}
                                  </>
                                ) : (
                                  s.action
                                )}
                              </button>
                            ))}
```

Update the published-state note so a non-testnet deploy reads "coming soon" instead of the mock note. Replace:
```tsx
                {phase === 'published' && (
                  <p className="demo-inscribe-note">
                    {testnet
                      ? isAuthenticated && bitcoin
                        ? demo.inscribeGate.yourKeyNote
                        : demo.inscribeGate.signInPrompt
                      : demo.inscribeGate.mockNote}
                  </p>
                )}
```
with:
```tsx
                {phase === 'published' && (
                  <p className="demo-inscribe-note">
                    {testnet
                      ? isAuthenticated && bitcoin
                        ? demo.inscribeGate.yourKeyNote
                        : demo.inscribeGate.signInPrompt
                      : demo.comingSoon}
                  </p>
                )}
```

(Leave the `inscribe` action function, the `btcTestnetEnabled()`-gated real path, and the `?smoke=1` harness's direct `engine.inscribe({ feeRate: 7 })` untouched — the disabled button simply never invokes `inscribe` when `!testnet`.)

- [ ] **Step 5: Run the content test to verify it passes**

Run: `cd apps/landing && bun test src/components/demo-coming-soon-content.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 6: Full landing sweep (no regressions)**

Run: `cd apps/landing && bun test`
Expected: PASS — all landing suites green (server + src), including the existing `demo-content.test.ts`, `demo-inscribe-content.test.ts`, `engine.summary.test.ts`, `engine.publish-resolve.test.ts`, and the new suites from Tasks 1–5.

- [ ] **Step 7: Manual smoke (dev)**

In one terminal: `cd apps/landing && ORIGINALS_DATA_DIR=./.originals-data bun run server/index.ts` (needs `JWT_SECRET` + `TURNKEY_*` for auth; without them the originals routes stay unmounted and `/api/originals*` 404s — expected). In another: `cd apps/landing && bun run dev`. Signed in, run Create → Publish and confirm: the demo hosts durably (a file tree appears under `apps/landing/.originals-data/hosted/…`), and `/me` lists the new Original with its thumbnail + did:webvh + open-log link (the badge shows "resolves in production" in http dev — correct). The Inscribe step shows the disabled "Coming soon" button and never fires an event. Signed out, the demo still publishes ephemerally (no `.originals-data` write) and `/me` shows the sign-in prompt.

- [ ] **Step 8: Commit**

```bash
git add apps/landing/src/content.ts apps/landing/src/components/Demo.tsx apps/landing/src/components/demo-coming-soon-content.test.ts
git commit -m "feat(landing): Inscribe step becomes honest 'Coming soon' (did:btco stays gated)"
```

---

## Deploy

- Attach a **Railway volume** (e.g. mounted at `/data`) to the landing service and set `ORIGINALS_DATA_DIR=/data`. Without a volume the container FS is ephemeral and Originals disappear on redeploy.
- No new service, no DB. The originals routes mount only when auth is configured (`JWT_SECRET` + `TURNKEY_*`), matching the existing `buildApiRoutes` gate. Dev falls back to `./.originals-data` (gitignored).

---

## Self-review notes (done before saving)

- **Spec coverage:**
  - Durable filesystem store (`saveBytes`/`recordOriginal`/`list`/`serve`, quota, traversal-hardened, restart durability, per-user isolation) → Task 1.
  - Auth-gated `PUT /api/originals/host/*` (durable) + `POST /api/originals` + `GET /api/originals`; `buildRoutes` mount; `buildFetch` wildcard dispatch + durable `serve` fallback; `serve.ts` + `index.ts` wiring; `.gitignore` → Task 2.
  - `DurableHostingStorageAdapter` over `/api/originals/host/*` with `credentials:'same-origin'` → Task 3.
  - Engine `authed` publish (durable adapter + summary POST), anonymous path unchanged → Task 4.
  - `/me` page + hand-rolled router + nav link + `content.ts` copy → Task 5.
  - Inscribe "Coming soon" (did:btco gated path untouched, `?smoke=1` untouched) → Task 6.
  - Deploy (Railway volume at `ORIGINALS_DATA_DIR`) → Deploy section.
- **Placeholder scan:** every code step contains complete code; no TODO/TBD/"add error handling"; all test commands are exact `cd apps/landing && bun test <path>` with expected PASS/FAIL.
- **Type/name consistency:**
  - `createOriginalsStore({ dataDir, maxOriginals?, maxTotalBytes? })` → `OriginalsStore` with `saveBytes(sub,key,bytes,ct)` / `recordOriginal(sub,{did,title,resourceHash,createdAt})` / `list(sub)` / `serve(url)` — identical in Task 1 (definition), Task 2 (routes consume it), and Task 4 (test constructs it).
  - `createOriginalsRoutes({ jwtSecret, store })` → `OriginalsRoutes { hostPut(req,url,clientIp), record, list, serve(url) }` — identical across Task 2 (`app.ts` uses `hostPut`/`serve`; `index.ts`/`serve.ts` mount `record`/`list`) and Task 4 (test uses `record`/`list` + passes `originals` to `buildFetch`).
  - `buildFetch` deps `{ apiRoutes, hostStore, distDir, originals? }` — the added `originals` key is threaded identically from `serve.ts` (`api?.originals`) and `index.ts` dev block; matches the shape the Task 2/4 tests pass.
  - `DurableHostingStorageAdapter` (`put`/`get`, `{ baseUrl?, fetchImpl? }`) — name identical in Task 3 (definition), Task 4 (engine import). Distinct from the unchanged `HttpHostingStorageAdapter`.
  - `DemoEngine` constructor `opts?: { authed?: boolean }` — used in Task 4 engine + `useEngine(authed)` in `Demo.tsx`; the anonymous `new DemoEngine()` call sites (publish-resolve/summary tests, `?smoke=1`) still type-check (opts optional).
  - `routeForPath` / `useLocationPath` / `navigate` — defined in Task 5 `router.tsx`, consumed by `App.tsx` + `Nav.tsx`; `routeForPath` is the pure unit under test.
  - `yourOriginals` copy keys (`navLabel`/`heading`/`signedOut`/`emptyTitle`/`emptyCta`/`resolvedBadge`/`pendingBadge`/`openLog`) — the content test asserts them and `YourOriginals.tsx`/`Nav.tsx` consume exactly those names.
  - `demo.comingSoon` — added in Task 6 content, consumed by `Demo.tsx` (button label + published note) and asserted by the Task 6 test.
- **Known risks / decisions (flagged for the reviewer):**
  - **Thumbnail derivation.** The recorded summary stays the spec's exact tuple `{did,title,resourceHash,createdAt}`; the artwork thumbnail's `resourceUrl` is *derived* in `list()` by matching the user's saved keys against the did's `…/resources/` prefix (uses "saveBytes records the key under the user" from the design). If a did has no saved resource key, the row falls back to a monogram tile. No SVG bytes are duplicated into the index.
  - **Durable `serve` + `<img>`.** The resource is served with `content-disposition: attachment` + `nosniff`; browsers still render it via `<img>` (disposition governs navigation/download, not embedding) because the stored `content-type` is the real `image/svg+xml`. Same-origin in prod, so it loads.
  - **Live `resolveDID` on `/me` is best-effort** (the resolver hard-codes `https`, so dev http shows "resolves in production"); this mirrors the demo's existing caveat and is not asserted in tests (the list tests are pure-logic).
  - **Shared public `hosted/` tree.** Keys are content-addressed (did:webvh SCID/slug), so cross-user collisions are effectively impossible; the per-user index enforces ownership for `list`. A hardening follow-up could namespace hosted bytes by sub, at the cost of resolver-URL fidelity.
