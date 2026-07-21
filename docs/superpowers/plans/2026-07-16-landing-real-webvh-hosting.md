# Landing Demo — Real did:webvh Hosting (Phase 0 + Track A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the landing demo's "Publish" step do REAL did:webvh hosting — the signed DID log (+ CEL log + resources) is uploaded to the demo's own origin over HTTP(S), the SDK's real resolver fetches it back, and the UI proves it resolved — plus fold the split static/API servers into one Bun entry and fix the did:peer→did:cel / mock-hosting mislabels.

**Architecture:** One Bun server (rewritten `apps/landing/serve.ts`) serves the static SPA (with SPA fallback + path-traversal guard), the existing `/api/auth/*` routes (only when `JWT_SECRET` + `TURNKEY_*` env are present; otherwise 503 stubs so the SPA and Track A run WITHOUT secrets), a new `PUT /api/host/*` write endpoint, and GETs of the hosted DID logs at the EXACT URLs `didwebvh-ts`'s resolver requests. In the browser, a new `HttpHostingStorageAdapter` (SDK `StorageAdapter` interface A: `put`/`get`) routes all lifecycle hosting writes through `PUT /api/host/*`; after `publishToWeb` the engine calls `sdk.did.resolveDID(publisherDid, { skipCache: true })` to prove real network resolution and emits a `did:webvh:resolved` event carrying the resolvable log URL.

**Tech Stack:** Bun (runtime + test runner), TypeScript, `@originals/sdk`, `didwebvh-ts` v2.8.0, Vite 8 / React 19, `@originals/auth`.

## Global Constraints

- **Runtime & tests:** Bun only. Server tests live in `apps/landing/server/tests/*.test.ts`; browser/SDK tests in `apps/landing/src/**/*.test.ts`. Run with `cd apps/landing && bun test <path>`. Import test primitives from `bun:test` (`import { describe, test, expect } from 'bun:test'`). Follow the style of `apps/landing/server/tests/router.test.ts`.
- **Absolute imports inside the SDK package only** — inside `apps/landing` use the existing relative-import style already present in the files you touch.
- **Noble imports:** `@noble/hashes/sha2.js` (never `/sha256`).
- **Multikey encoding only** — never JWK. (Not touched by this plan, but do not introduce JWK.)
- **Track B is OUT OF SCOPE.** This plan is Phase 0 + Phase 1/Track A only. Do NOT touch Bitcoin inscription, `OrdMockProvider`, `HttpOrdinalsProvider`, `TurnkeySatSigner`, faucet, or QuickNode. The `inscribe()` step stays exactly as-is (mock). Leave all inscription/Bitcoin copy in `content.ts` unchanged.
- **`content.ts` reconciliation is out of scope** except the specific create/publish/hosting step strings named in Task 2.
- **No raw private keys anywhere on the server.** (Track A introduces none; keep it that way.)
- **Honesty rule:** every step's UI/badge copy must state exactly what is real vs. simulated. Create = real crypto, offline. Publish = real HTTP(S) did:webvh hosting + resolution. Inscribe = still mock (unchanged).

---

## Resolved facts (locked in Task 0 — read before coding)

Confirmed by reading `node_modules/.bun/didwebvh-ts@2.8.0/node_modules/didwebvh-ts/dist/esm/index.js` (the version `apps/landing` resolves) and `packages/sdk/src/lifecycle/LifecycleManager.ts`.

**1. The resolver's GET URL (`getFileUrl` → `resolveDID` → `fetch`).** For a DID `did:webvh:<SCID>:<domain>[:<segA>:<segB>…]`:
- **Pathed DID** (has segments after the domain): `getFileUrl` returns
  `https://<host>[:<port>]/<segA>/<segB>/did.jsonl`.
- **Domain-root DID** (no segments): `https://<host>[:<port>]/.well-known/did.jsonl`.
- **Protocol is hard-coded `https`** (`const protocol = "https"` in `getBaseUrl`). There is no http fallback — see dev caveat below.
- The resolver ALSO best-effort fetches the witness proofs at the same URL with `did.jsonl` → `did-witness.json` (`fetchWitnessProofs`); a `404` there is harmless (returns `[]`). The host store therefore only strictly needs to serve `did.jsonl`; a missing `did-witness.json` is fine.
- `resolveDID` fetches ONLY the log (`fetchLogFromIdentifier` → `fetch(getFileUrl(did))`). It does not fetch `cel.json` or resources — those are hosted for the demo/provenance but the resolver never requests them.

**2. What the SDK writes (`LifecycleManager`, via storage adapter `put`).** `webvhStorageLocation(did, filename)` splits the DID: `domain = decodeURIComponent(parts[3])`, `pathParts = parts.slice(4)`, and
`relativePath = pathParts.length ? \`${pathParts.join('/')}/${filename}\` : \`.well-known/${filename}\``.
When the adapter has `.put`, the SDK calls `put(\`${domain}/${relativePath}\`, Buffer.from(bytes), { contentType })`:
- DID log → key `\`${domain}/${relativePath}\`` with `filename = did.jsonl`, contentType `application/jsonl`.
- CEL log (webvh sibling) → same shape, `filename = cel.json`, contentType `application/json`.
- Resources → key `\`${domain}/${userPath ? userPath + '/' : ''}resources/${multibase}\``, contentType = the resource's contentType.
- CEL demo-copy (`persistCelArtifacts`) → key `\`cel/${suffix}.json\`` (NO domain prefix), contentType `application/json`. The resolver never fetches this; it just occupies a store slot.

**3. The exact mapping (this is the whole point).** The storage `put` key is `\`${domain}/${relativePath}\``. The resolver GETs `https://${domain}/${relativePath}` (domain in the DID = the origin host; `relativePath` = `<segs>/did.jsonl` or `.well-known/did.jsonl`). So on an incoming GET, the store's lookup key is exactly **`\`${url.host}${url.pathname}\``** (host header includes the port; `url.pathname` starts with `/` and equals `/${relativePath}`). This is byte-identical to the `put` key. The host GET routing MUST serve on that reconstruction — do not invent a different path scheme.

Worked example (paths `['studio','you']`, origin host `demo.example.com`):
- DID `did:webvh:<SCID>:demo.example.com:studio:you`
- `put` key = `demo.example.com/studio/you/did.jsonl`
- resolver GET = `https://demo.example.com/studio/you/did.jsonl` → store key `demo.example.com/studio/you/did.jsonl` ✓

Port example (dev origin host `localhost:5173`): the DID encodes the port colon as `%3A` (`did:webvh:<SCID>:localhost%3A5173:studio:you`); the SDK's `decodeURIComponent(parts[3])` gives `localhost:5173`, so `put` key = `localhost:5173/studio/you/did.jsonl`, and `url.host` on the served request = `localhost:5173`. Still identical.

**4. Dev caveat (protocol forced to https).** Because `getBaseUrl` hard-codes `https`, a localhost dev origin served over `http` cannot be resolved by `didwebvh-ts` (it will `fetch('https://localhost:5173/...')` and fail). Therefore the post-publish `resolveDID` step is **best-effort in dev (failure is expected and non-fatal) and authoritative in production** (real HTTPS origin). The `did:webvh:resolved` event carries `resolved: boolean` so the UI shows the link always and the "resolved ✓" tick only when resolution actually succeeded. Integration tests (Task 5) stub `globalThis.fetch` so resolution is deterministic without a live HTTPS origin.

---

## Task 1: Unified Bun server (static + SPA + `/api` + host mounts)

**Files:**
- Create: `apps/landing/server/app.ts`
- Modify: `apps/landing/server/index.ts` (add `buildStubRoutes`)
- Modify: `apps/landing/serve.ts` (rewrite as the unified prod entry)
- Modify: `railway.json` (confirm `startCommand`)
- Modify: `apps/landing/vite.config.ts` (confirm dev proxy comment)
- Test: `apps/landing/server/tests/app.test.ts`

**Interfaces:**
- Consumes: `route`, `json`, `type Handler` from `./router`; `type WebvhHostStore` from `./webvh-host` (Task 4 — for Task 1, use the minimal stub host store defined in Step 3 below so Task 1 stands alone).
- Produces:
  - `buildFetch(deps: { routes: Record<string, Handler>; hostStore: WebvhHostStore; distDir: string }): (req: Request) => Promise<Response>`
  - `buildStubRoutes(): Record<string, Handler>` (503 for auth routes, ok for health).
  - `WebvhHostStore` shape used here: `{ handlePut(req: Request, url: URL): Promise<Response>; serve(req: Request, url: URL): Response | null }`. Task 4 implements the real one with the SAME two-method surface.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/server/tests/app.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFetch } from '../app';
import { buildStubRoutes } from '../index';
import { json, type Handler } from '../router';

// A no-op host store matching the WebvhHostStore surface buildFetch depends on.
const noopHostStore = {
  async handlePut() {
    return json({ error: 'not_implemented' }, 501);
  },
  serve() {
    return null as Response | null;
  },
};

let distDir: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'landing-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(dir, 'app.js'), 'console.log("asset")');
  distDir = dir + '/';
});

afterAll(() => rmSync(distDir, { recursive: true, force: true }));

function makeFetch(routes: Record<string, Handler>) {
  return buildFetch({ routes, hostStore: noopHostStore, distDir });
}

describe('unified server buildFetch', () => {
  test('serves a real static asset from dist', async () => {
    const res = await makeFetch(buildStubRoutes())(new Request('http://x/app.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('asset');
  });

  test('SPA fallback: unknown non-file path returns index.html', async () => {
    const res = await makeFetch(buildStubRoutes())(new Request('http://x/some/client/route'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa');
  });

  test('rejects path traversal', async () => {
    const res = await makeFetch(buildStubRoutes())(
      new Request('http://x/..%2f..%2fetc%2fpasswd')
    );
    expect(res.status).toBe(400);
  });

  test('GET /api/health returns ok', async () => {
    const res = await makeFetch(buildStubRoutes())(new Request('http://x/api/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('auth route returns 503 when unconfigured', async () => {
    const res = await makeFetch(buildStubRoutes())(
      new Request('http://x/api/auth/send-otp', { method: 'POST' })
    );
    expect(res.status).toBe(503);
  });

  test('POST /api/host/* is routed to the host store, not static', async () => {
    const res = await makeFetch(buildStubRoutes())(
      new Request('http://x/api/host/whatever', { method: 'PUT' })
    );
    expect(res.status).toBe(501); // noopHostStore.handlePut
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/app.test.ts`
Expected: FAIL — `Cannot find module '../app'` (and `buildStubRoutes` is not exported from `../index`).

- [ ] **Step 3: Implement `buildFetch` in `apps/landing/server/app.ts`**

```typescript
import { file } from 'bun';
import { normalize } from 'node:path';
import { route, type Handler } from './router';

// Minimal surface buildFetch depends on; the real store (webvh-host.ts, Task 4)
// implements exactly these two methods.
export interface WebvhHostStore {
  handlePut(req: Request, url: URL): Promise<Response>;
  serve(req: Request, url: URL): Response | null;
}

async function serveStatic(url: URL, distDir: string): Promise<Response> {
  // Strip leading slashes, normalize, reject path traversal (moved from serve.ts).
  const rel = normalize(decodeURIComponent(url.pathname))
    .replace(/^(\.\.(\/|\\|$))+/, '')
    .replace(/^\/+/, '');
  if (rel.includes('..')) return new Response('Bad request', { status: 400 });
  const target = rel === '' ? 'index.html' : rel;
  const f = file(distDir + target);
  if (await f.exists()) return new Response(f);
  // SPA fallback: client-side routes have no file on disk.
  return new Response(file(distDir + 'index.html'), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export function buildFetch(deps: {
  routes: Record<string, Handler>;
  hostStore: WebvhHostStore;
  distDir: string;
}): (req: Request) => Promise<Response> {
  const { routes, hostStore, distDir } = deps;
  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // 1. WebVH host writes (wildcard path — not expressible in the exact route map).
    if (path.startsWith('/api/host/')) return hostStore.handlePut(req, url);

    // 2. All other /api/* — exact-match route map (auth routes or 503 stubs + health).
    if (path.startsWith('/api/')) return route(req, routes);

    // 3. WebVH log/resource GETs served at the resolver's exact URLs.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = hostStore.serve(req, url);
      if (served) return served;
    }

    // 4. Static SPA + fallback (with traversal guard).
    return serveStatic(url, distDir);
  };
}
```

- [ ] **Step 4: Add `buildStubRoutes` to `apps/landing/server/index.ts`**

Add this exported function (leave `buildRoutes` and the `if (import.meta.main)` block untouched — the block is now dead in prod because `serve.ts` is the entry, but keep it for standalone `bun run server/index.ts` dev use):

```typescript
// Routes for when Turnkey/JWT env is absent: health works, auth returns 503 so
// the SPA + Track A (real webvh hosting) run WITHOUT any secrets.
export function buildStubRoutes(): Record<string, Handler> {
  const unavailable: Handler = () =>
    json(
      { error: 'auth_unconfigured', message: 'Authentication is not configured on this server.' },
      503
    );
  return {
    'GET /api/health': () => json({ status: 'ok' }),
    'POST /api/auth/send-otp': unavailable,
    'POST /api/auth/verify-otp': unavailable,
    'GET /api/me': unavailable,
    'POST /api/auth/logout': unavailable,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/landing && bun test server/tests/app.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 6: Rewrite `apps/landing/serve.ts` as the unified prod entry**

Replace the entire file with:

```typescript
/**
 * Unified production server for the landing app (Railway entry).
 *
 * One origin serves: the built SPA (with SPA fallback + traversal guard), the
 * auth API (only when JWT_SECRET + TURNKEY_* are present; otherwise 503 stubs),
 * the WebVH host write endpoint (PUT /api/host/*), and the hosted did:webvh logs
 * at the exact URLs didwebvh-ts's resolver GETs. No secrets are required to run
 * the SPA and the real did:webvh hosting demo (Track A).
 */
import { createInMemorySessionStorage } from '@originals/auth/server';
import { buildFetch } from './server/app';
import { createWebvhHostStore } from './server/webvh-host';
import { buildRoutes, buildStubRoutes } from './server/index';
import { getTurnkey } from './server/turnkey';

const distDir = new URL('./dist/', import.meta.url).pathname;
const hostStore = createWebvhHostStore();

const jwtSecret = process.env.JWT_SECRET;
const turnkeyConfigured =
  !!process.env.TURNKEY_API_PUBLIC_KEY &&
  !!process.env.TURNKEY_API_PRIVATE_KEY &&
  !!process.env.TURNKEY_ORGANIZATION_ID;

let routes;
if (jwtSecret && turnkeyConfigured) {
  routes = buildRoutes({
    turnkey: getTurnkey(),
    sessions: createInMemorySessionStorage(),
    jwtSecret,
  });
  console.log('[landing] auth configured — /api/auth/* live');
} else {
  console.warn(
    '[landing] auth unconfigured (JWT_SECRET/TURNKEY_* absent) — /api/auth/* returns 503; SPA + did:webvh hosting still work'
  );
  routes = buildStubRoutes();
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  hostname: '0.0.0.0',
  fetch: buildFetch({ routes, hostStore, distDir }),
});

console.log(`[landing] unified server on http://0.0.0.0:${server.port}`);
```

Note: this file imports `createWebvhHostStore` from `./server/webvh-host` (Task 4). Until Task 4 lands, `bun run apps/landing/serve.ts` will fail to import — that is expected; Task 1's deliverable is verified by `app.test.ts`, not by booting `serve.ts`. Do NOT create a placeholder `webvh-host.ts` here; Task 4 owns it. Sequence Task 4 before manually booting `serve.ts`.

- [ ] **Step 7: Confirm `railway.json` `startCommand` targets the unified entry**

Read `railway.json`. It already reads `"startCommand": "bun run apps/landing/serve.ts"`. `serve.ts` is now the unified entry, so this line is correct and needs **no change**. Verify it reads exactly `bun run apps/landing/serve.ts` and leave it. (The `buildCommand` also stays unchanged.)

- [ ] **Step 8: Confirm the Vite dev proxy still targets the unified server port**

Read `apps/landing/vite.config.ts`. The dev proxy is `server.proxy = { '/api': 'http://localhost:8787' }`. The unified server defaults to `PORT ?? 8787`, so dev (`bun run apps/landing/serve.ts` with no `PORT`) listens on 8787 and the proxy is already correct. Update ONLY the proxy comment (lines ~72-73) to reflect the unified server:

Replace:
```typescript
  // Same-origin proxy so the browser reaches the standalone auth server
  // (server/index.ts on :8787) without CORS and the httpOnly cookie works.
```
with:
```typescript
  // Same-origin proxy so the browser reaches the unified Bun server
  // (serve.ts on :8787: auth + PUT /api/host/*) without CORS and cookies work.
```

- [ ] **Step 9: Run the test once more and commit**

Run: `cd apps/landing && bun test server/tests/app.test.ts`
Expected: PASS — 6 tests pass.

```bash
git add apps/landing/server/app.ts apps/landing/server/index.ts apps/landing/serve.ts apps/landing/vite.config.ts apps/landing/server/tests/app.test.ts railway.json
git commit -m "feat(landing): unified Bun server (static + SPA + /api + host mounts)"
```

---

## Task 2: Honesty labels (did:peer→did:cel, real hosting wording)

**Files:**
- Modify: `apps/landing/src/sdk/engine.ts` (lines ~117-124: `asset:created` + `resource:published` summaries; lines 1-13 header comment)
- Modify: `apps/landing/src/content.ts` (lines ~120-121 create description; lines ~129-130 publish description)
- Test: `apps/landing/src/sdk/engine.summary.test.ts`

**Interfaces:**
- Consumes: `DemoEngine` from `./engine`; `demo` from `../content`.
- Produces: no new exports; asserts observable summary/content strings.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/sdk/engine.summary.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { DemoEngine } from './engine';
import { demo } from '../content';

describe('honesty labels', () => {
  test('content: create step no longer claims a did:peer identity', () => {
    expect(demo.steps[0].description).toContain('did:cel');
    expect(demo.steps[0].description).not.toContain('did:peer identity');
  });

  test('content: publish step describes real hosting/resolution', () => {
    expect(demo.steps[1].description.toLowerCase()).toMatch(/host|resolv/);
  });

  test('asset:created summary says did:cel, not "a private did:peer identity"', async () => {
    const engine = new DemoEngine();
    const summaries: string[] = [];
    engine.on((e) => {
      if (e.type === 'asset:created') summaries.push(e.summary);
    });
    await engine.create('Test Piece', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain('did:cel');
    expect(summaries[0]).not.toContain('did:peer identity');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/engine.summary.test.ts`
Expected: FAIL — `demo.steps[0].description` still contains `did:peer identity`; `asset:created` summary still says `a private did:peer identity`.

- [ ] **Step 3: Fix the `asset:created` summary in `apps/landing/src/sdk/engine.ts`**

Replace:
```typescript
    forward('asset:created', (e: { asset: { id: string } }) =>
      `Asset created as ${short(e.asset.id)} — a private did:peer identity, generated entirely offline`
    );
```
with:
```typescript
    forward('asset:created', (e: { asset: { id: string } }) =>
      `Asset created as ${short(e.asset.id)} — a did:cel genesis (a signed event log), generated entirely offline in this tab`
    );
```

- [ ] **Step 4: Fix the `resource:published` summary in `apps/landing/src/sdk/engine.ts`**

Replace:
```typescript
    forward(
      'resource:published',
      (e: { resource: { id: string } }) =>
        `Resource "${e.resource.id}" published to hosted storage`
    );
```
with:
```typescript
    forward(
      'resource:published',
      (e: { resource: { id: string } }) =>
        `Resource "${e.resource.id}" hosted over HTTP at this origin — its did:webvh log is now resolvable`
    );
```

- [ ] **Step 5: Fix the header comment in `apps/landing/src/sdk/engine.ts`**

Replace the header sentence (lines ~5-8):
```typescript
 * DIDs, hashes, credentials, events and provenance all come back from
 * actual SDK calls. Bitcoin operations run against OrdMockProvider, the
 * SDK's own in-memory Ordinals provider, so no wallet or node is needed.
```
with:
```typescript
 * DIDs, hashes, credentials, events and provenance all come back from
 * actual SDK calls. Publishing hosts the signed did:webvh log at this origin
 * over real HTTP(S) and the SDK's real resolver fetches it back. Bitcoin
 * operations still run against OrdMockProvider (no wallet or node needed).
```

- [ ] **Step 6: Fix the create + publish step copy in `apps/landing/src/content.ts`**

Replace the create description (lines ~120-121):
```typescript
      description:
        'Hashes the artwork’s bytes and mints a did:peer identity — entirely in this tab, no server involved.'
```
with:
```typescript
      description:
        'Hashes the artwork’s bytes and mints its did:cel genesis — a signed event log, entirely in this tab, no server involved.'
```

Replace the publish description (lines ~129-130):
```typescript
      description:
        'Migrates the asset to did:webvh, publishes its resources, and signs a publication credential.'
```
with:
```typescript
      description:
        'Migrates the asset to did:webvh and hosts the signed DID log at this origin — the SDK’s real resolver then fetches it back over HTTP(S).'
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/engine.summary.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/landing/src/sdk/engine.ts apps/landing/src/content.ts apps/landing/src/sdk/engine.summary.test.ts
git commit -m "fix(landing): honest did:cel + real-hosting copy for create/publish"
```

---

## Task 3: `HttpHostingStorageAdapter` (browser, SDK StorageAdapter interface A)

**Files:**
- Create: `apps/landing/src/sdk/http-hosting-adapter.ts`
- Test: `apps/landing/src/sdk/http-hosting-adapter.test.ts`

**Interfaces:**
- Consumes: `globalThis.fetch`.
- Produces:
  - `class HttpHostingStorageAdapter` implementing SDK `StorageAdapter` interface A:
    - `put(objectKey: string, data: Buffer | Uint8Array | string, options?: { contentType?: string; cacheControl?: string }): Promise<string>` — PUTs to `\`${baseUrl}/api/host/${encodeURIComponent(objectKey)}\`` with the bytes as the body and `content-type` header; returns the public URL `\`${origin}/${objectKey}\`` (`https` scheme; this is the resolvable URL for did.jsonl keys).
    - `get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null>` — GETs `\`${baseUrl}/api/host/${encodeURIComponent(objectKey)}\``; `null` on 404.
  - `constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch })` — `baseUrl` defaults to `''` (same-origin relative URLs, correct in the browser); `fetchImpl` defaults to `globalThis.fetch` (injectable for tests).

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/sdk/http-hosting-adapter.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { HttpHostingStorageAdapter } from './http-hosting-adapter';

function mockFetch() {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();
  const calls: Array<{ method: string; url: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    if (method === 'PUT') {
      const buf = new Uint8Array(init!.body as ArrayBuffer);
      const ct = (init!.headers as Record<string, string>)['content-type'] ?? 'application/octet-stream';
      store.set(url, { body: buf, contentType: ct });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const hit = store.get(url);
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.body, { status: 200, headers: { 'content-type': hit.contentType } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HttpHostingStorageAdapter', () => {
  test('put encodes the key, PUTs the bytes, and returns a resolvable URL', async () => {
    const { impl, calls } = mockFetch();
    const adapter = new HttpHostingStorageAdapter({ baseUrl: '', fetchImpl: impl });
    const key = 'demo.example.com/studio/you/did.jsonl';
    const url = await adapter.put(key, Buffer.from('{"a":1}\n{"b":2}'), {
      contentType: 'application/jsonl',
    });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('/api/host/' + encodeURIComponent(key));
    expect(url).toBe('https://' + key);
  });

  test('get returns content + contentType, null on miss', async () => {
    const { impl } = mockFetch();
    const adapter = new HttpHostingStorageAdapter({ baseUrl: '', fetchImpl: impl });
    const key = 'demo.example.com/.well-known/did.jsonl';
    await adapter.put(key, 'hello', { contentType: 'application/jsonl' });
    const got = await adapter.get(key);
    expect(got).not.toBeNull();
    expect(got!.content.toString()).toBe('hello');
    expect(got!.contentType).toBe('application/jsonl');
    expect(await adapter.get('nope/missing')).toBeNull();
  });

  test('put throws on a non-ok, non-2xx response', async () => {
    const failing = (async () => new Response('too big', { status: 413 })) as unknown as typeof fetch;
    const adapter = new HttpHostingStorageAdapter({ baseUrl: '', fetchImpl: failing });
    await expect(adapter.put('k', 'x', { contentType: 'text/plain' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/http-hosting-adapter.test.ts`
Expected: FAIL — `Cannot find module './http-hosting-adapter'`.

- [ ] **Step 3: Implement `apps/landing/src/sdk/http-hosting-adapter.ts`**

```typescript
/**
 * SDK StorageAdapter (interface A: put/get) backed by this origin's HTTP host.
 *
 * The lifecycle's hosting writes (did.jsonl, cel.json, resources) call
 * put(`${domain}/${relativePath}`, bytes, { contentType }); we forward each to
 * PUT /api/host/<encoded key>. The returned URL is the resolvable HTTPS URL for
 * that key — for did.jsonl keys it is exactly what didwebvh-ts's resolver GETs.
 */
function toBytes(data: Buffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

export class HttpHostingStorageAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }) {
    // '' → same-origin relative URLs (correct in the browser).
    this.baseUrl = opts?.baseUrl ?? '';
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private endpoint(objectKey: string): string {
    return `${this.baseUrl}/api/host/${encodeURIComponent(objectKey)}`;
  }

  async put(
    objectKey: string,
    data: Buffer | Uint8Array | string,
    options?: { contentType?: string; cacheControl?: string }
  ): Promise<string> {
    const bytes = toBytes(data);
    const res = await this.fetchImpl(this.endpoint(objectKey), {
      method: 'PUT',
      headers: { 'content-type': options?.contentType ?? 'application/octet-stream' },
      // Copy into a fresh ArrayBuffer so the body is a plain BodyInit.
      body: bytes.slice().buffer,
    });
    if (!res.ok) {
      throw new Error(`HttpHostingStorageAdapter.put failed: ${res.status} for ${objectKey}`);
    }
    // The public, resolvable URL for this key (https — matches didwebvh-ts).
    return `https://${objectKey}`;
  }

  async get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null> {
    const res = await this.fetchImpl(this.endpoint(objectKey), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`HttpHostingStorageAdapter.get failed: ${res.status} for ${objectKey}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { content: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/http-hosting-adapter.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/sdk/http-hosting-adapter.ts apps/landing/src/sdk/http-hosting-adapter.test.ts
git commit -m "feat(landing): HttpHostingStorageAdapter over PUT/GET /api/host/*"
```

---

## Task 4: `webvh-host.ts` server module (store + serve at resolver URLs)

**Files:**
- Create: `apps/landing/server/webvh-host.ts`
- Test: `apps/landing/server/tests/webvh-host.test.ts`

**Interfaces:**
- Consumes: `json` from `./router`; `createRateLimiter` from `./rate-limit`; `WebvhHostStore` shape from `./app` (Task 1).
- Produces:
  - `createWebvhHostStore(opts?: { maxObjectBytes?: number; maxEntries?: number; ttlMs?: number; now?: () => number; limit?: number; windowMs?: number }): WebvhHostStore & { size(): number }` where `WebvhHostStore = { handlePut(req, url): Promise<Response>; serve(req, url): Response | null }`.
  - `handlePut` — `PUT /api/host/<encoded key>` only (else 405). Rate-limited per client IP. Rejects bodies over `maxObjectBytes` (413). Rejects new keys when the store is full after sweeping expired entries (507). Stores `{ body, contentType, expiresAt }`; 200 on success.
  - `serve` — reconstructs key `\`${url.host}${url.pathname}\`` (Resolved fact #3), returns a `Response` (200 with stored `content-type`) or `null` (unknown/expired → caller falls through to static/404). Sweeps expired entries first.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/server/tests/webvh-host.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { createWebvhHostStore } from '../webvh-host';

function putReq(key: string, body: string, contentType: string) {
  return new Request(`http://host/api/host/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
}

describe('webvh-host store', () => {
  test('put → serve roundtrip at the resolver URL', async () => {
    const store = createWebvhHostStore();
    const key = 'demo.example.com/studio/you/did.jsonl';
    const putRes = await store.handlePut(
      putReq(key, '{"v":1}\n{"v":2}', 'application/jsonl'),
      new URL(`http://host/api/host/${encodeURIComponent(key)}`)
    );
    expect(putRes.status).toBe(200);

    // Resolver GETs https://demo.example.com/studio/you/did.jsonl → host+pathname key.
    const getUrl = new URL('http://demo.example.com/studio/you/did.jsonl');
    const served = store.serve(new Request(getUrl), getUrl);
    expect(served).not.toBeNull();
    expect(served!.status).toBe(200);
    expect(served!.headers.get('content-type')).toBe('application/jsonl');
    expect(await served!.text()).toBe('{"v":1}\n{"v":2}');
  });

  test('serve returns null for unknown key', () => {
    const store = createWebvhHostStore();
    const url = new URL('http://demo.example.com/nope/did.jsonl');
    expect(store.serve(new Request(url), url)).toBeNull();
  });

  test('TTL expiry: serve returns null after ttl elapses', async () => {
    let clock = 1000;
    const store = createWebvhHostStore({ ttlMs: 500, now: () => clock });
    const key = 'demo.example.com/.well-known/did.jsonl';
    await store.handlePut(
      putReq(key, 'x', 'application/jsonl'),
      new URL(`http://host/api/host/${encodeURIComponent(key)}`)
    );
    const url = new URL('http://demo.example.com/.well-known/did.jsonl');
    expect(store.serve(new Request(url), url)).not.toBeNull();
    clock += 501; // past TTL
    expect(store.serve(new Request(url), url)).toBeNull();
  });

  test('size cap: body over maxObjectBytes is rejected 413', async () => {
    const store = createWebvhHostStore({ maxObjectBytes: 8 });
    const key = 'd/x/did.jsonl';
    const res = await store.handlePut(
      putReq(key, 'this body is longer than eight bytes', 'application/jsonl'),
      new URL(`http://host/api/host/${encodeURIComponent(key)}`)
    );
    expect(res.status).toBe(413);
  });

  test('entry cap: rejects a new key when full (507)', async () => {
    const store = createWebvhHostStore({ maxEntries: 1 });
    await store.handlePut(
      putReq('a/x/did.jsonl', 'a', 'application/jsonl'),
      new URL(`http://host/api/host/${encodeURIComponent('a/x/did.jsonl')}`)
    );
    const res = await store.handlePut(
      putReq('b/x/did.jsonl', 'b', 'application/jsonl'),
      new URL(`http://host/api/host/${encodeURIComponent('b/x/did.jsonl')}`)
    );
    expect(res.status).toBe(507);
  });

  test('non-PUT method is rejected 405', async () => {
    const store = createWebvhHostStore();
    const url = new URL('http://host/api/host/whatever');
    const res = await store.handlePut(new Request(url, { method: 'POST' }), url);
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test server/tests/webvh-host.test.ts`
Expected: FAIL — `Cannot find module '../webvh-host'`.

- [ ] **Step 3: Implement `apps/landing/server/webvh-host.ts`**

```typescript
/**
 * In-memory WebVH host: receives the SDK's hosting writes at PUT /api/host/<key>
 * and serves them back at the EXACT URLs didwebvh-ts's resolver GETs.
 *
 * The put key is `${domain}/${relativePath}` (LifecycleManager). The resolver
 * GETs https://${domain}/${relativePath}, so on serve the lookup key is
 * `${url.host}${url.pathname}` — byte-identical to the put key. Bounded by a
 * per-object size cap, a total-entry cap, and a TTL; PUTs are rate-limited.
 */
import { json } from './router';
import { createRateLimiter } from './rate-limit';

interface Entry {
  body: Uint8Array;
  contentType: string;
  expiresAt: number;
}

const HOST_PREFIX = '/api/host/';

export function createWebvhHostStore(opts?: {
  maxObjectBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  limit?: number;
  windowMs?: number;
}) {
  const maxObjectBytes = opts?.maxObjectBytes ?? 256 * 1024; // 256 KiB per object
  const maxEntries = opts?.maxEntries ?? 500;
  const ttlMs = opts?.ttlMs ?? 30 * 60 * 1000; // 30 minutes
  const now = opts?.now ?? Date.now;
  const limiter = createRateLimiter({
    limit: opts?.limit ?? 120,
    windowMs: opts?.windowMs ?? 60_000,
  });

  const map = new Map<string, Entry>();

  function sweep(): void {
    const t = now();
    for (const [k, e] of map) if (e.expiresAt <= t) map.delete(k);
  }

  function clientIp(req: Request): string {
    return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  }

  async function handlePut(req: Request, url: URL): Promise<Response> {
    if (req.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);

    const rl = limiter.check(clientIp(req));
    if (!rl.allowed) {
      return json({ error: 'rate_limited' }, 429, {
        'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }

    const key = decodeURIComponent(url.pathname.slice(HOST_PREFIX.length));
    if (!key) return json({ error: 'missing_key' }, 400);

    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > maxObjectBytes) {
      return json({ error: 'too_large', maxObjectBytes }, 413);
    }

    sweep();
    if (!map.has(key) && map.size >= maxEntries) {
      return json({ error: 'store_full', maxEntries }, 507);
    }

    map.set(key, {
      body,
      contentType: req.headers.get('content-type') ?? 'application/octet-stream',
      expiresAt: now() + ttlMs,
    });
    return json({ ok: true }, 200);
  }

  function serve(_req: Request, url: URL): Response | null {
    sweep();
    const key = `${url.host}${url.pathname}`;
    const entry = map.get(key);
    if (!entry) return null;
    // Copy so the caller can't mutate stored bytes.
    return new Response(entry.body.slice(), {
      status: 200,
      headers: { 'content-type': entry.contentType },
    });
  }

  return { handlePut, serve, size: () => map.size };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/landing && bun test server/tests/webvh-host.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Verify the unified server boots with the real host store wired**

The `serve.ts` written in Task 1 already imports `createWebvhHostStore` from `./server/webvh-host`. Confirm the whole server test suite still passes:

Run: `cd apps/landing && bun test server/tests/app.test.ts server/tests/webvh-host.test.ts`
Expected: PASS — 12 tests pass (6 + 6).

- [ ] **Step 6: Commit**

```bash
git add apps/landing/server/webvh-host.ts apps/landing/server/tests/webvh-host.test.ts
git commit -m "feat(landing): webvh-host store — serve DID logs at resolver URLs, bounded by TTL/caps"
```

---

## Task 5: Engine wiring (real hosting adapter + post-publish resolve)

**Files:**
- Modify: `apps/landing/src/sdk/engine.ts` (imports, constructor `storageAdapter`, `network`, `publish()`, new `webvhLogUrl` helper, `DemoAssetState`)
- Test: `apps/landing/src/sdk/engine.publish-resolve.test.ts`

**Interfaces:**
- Consumes: `HttpHostingStorageAdapter` from `./http-hosting-adapter` (Task 3); `createWebvhHostStore` from `../../server/webvh-host` (Task 4, test only).
- Produces:
  - `DemoEngine.publish()` now: passes an explicit webvh `domain` to `createDIDWebVH`, and after `publishToWeb` calls `sdk.did.resolveDID(this.publisherDid, { skipCache: true })`, emitting a `did:webvh:resolved` event with payload `{ logUrl: string; resolved: boolean; doc: unknown }`.
  - `DemoAssetState` gains `webvhLogUrl?: string` and `webvhResolved?: boolean`.
  - Module helper `webvhLogUrl(did: string): string` mirroring `getFileUrl` (https; `<segs>/did.jsonl` vs `.well-known/did.jsonl`).
  - `demoHost(): string` — the origin host the engine hosts under: `import.meta.env?.VITE_WEBVH_HOST` if set, else `window.location.host`, else `'localhost'` (SSR/test guard).

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/sdk/engine.publish-resolve.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { createWebvhHostStore } from '../../server/webvh-host';

// Route the browser adapter's PUT /api/host/* AND the resolver's https GETs
// through one in-process host store, so publish → resolve is deterministic
// without a live HTTPS origin (Resolved fact #4).
function installHostFetch(host: string) {
  const store = createWebvhHostStore();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(raw, `http://${host}`);
    if (url.pathname.startsWith('/api/host/')) {
      const req = new Request(url, {
        method,
        headers: init?.headers as HeadersInit,
        body: init?.body as BodyInit,
      });
      return store.handlePut(req, url);
    }
    // Resolver GET https://<host>/<path>/did.jsonl → serve from the store.
    const served = store.serve(new Request(url), url);
    if (served) return served;
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe('publish → resolve roundtrip', () => {
  const host = 'demo.test';
  let restore: () => void;

  beforeEach(() => {
    (import.meta as unknown as { env: Record<string, string> }).env ??= {};
    (import.meta as unknown as { env: Record<string, string> }).env.VITE_WEBVH_HOST = host;
    restore = installHostFetch(host);
  });
  afterEach(() => restore());

  test('publishes the DID log and resolves it back over (mocked) HTTPS', async () => {
    const engine = new DemoEngine();
    const resolvedEvents: Array<{ logUrl: string; resolved: boolean }> = [];
    engine.on((e) => {
      if (e.type === 'did:webvh:resolved') {
        resolvedEvents.push(e.payload as { logUrl: string; resolved: boolean });
      }
    });

    await engine.create('Roundtrip', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const state = await engine.publish();

    expect(state.layer).toBe('did:webvh');
    expect(state.webvhLogUrl).toBe(`https://${host}/studio/you/did.jsonl`);
    expect(state.webvhResolved).toBe(true);

    expect(resolvedEvents.length).toBe(1);
    expect(resolvedEvents[0].logUrl).toBe(`https://${host}/studio/you/did.jsonl`);
    expect(resolvedEvents[0].resolved).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/sdk/engine.publish-resolve.test.ts`
Expected: FAIL — `state.webvhLogUrl` is `undefined` (engine still uses `MemoryStorageAdapter`, passes no domain, emits no `did:webvh:resolved`).

- [ ] **Step 3: Swap the storage adapter + network in the engine constructor**

In `apps/landing/src/sdk/engine.ts`, replace the import:
```typescript
import {
  OriginalsSDK,
  OrdMockProvider,
  MemoryStorageAdapter,
  type OriginalsAsset
} from '@originals/sdk';
```
with:
```typescript
import {
  OriginalsSDK,
  OrdMockProvider,
  type OriginalsAsset
} from '@originals/sdk';
import { HttpHostingStorageAdapter } from './http-hosting-adapter';
```

Replace the `storageAdapter` line in the `OriginalsSDK.create({ ... })` call:
```typescript
      storageAdapter: new MemoryStorageAdapter(),
```
with:
```typescript
      // Real HTTP hosting at this origin — the SDK's did:webvh log becomes
      // resolvable over HTTP(S) (see http-hosting-adapter.ts).
      storageAdapter: new HttpHostingStorageAdapter(),
```

Leave `network: 'regtest'` and the OrdMockProvider unchanged — Bitcoin/network changes are Track B (Plan 2).

- [ ] **Step 4: Add the `demoHost` + `webvhLogUrl` helpers**

At the bottom of `apps/landing/src/sdk/engine.ts` (next to `toHex`), add:

```typescript
// The origin host we host did:webvh logs under. In the browser this is the
// live origin; VITE_WEBVH_HOST overrides it for the deployed host or tests.
function demoHost(): string {
  const envHost = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WEBVH_HOST;
  if (envHost) return envHost;
  if (typeof window !== 'undefined' && window.location?.host) return window.location.host;
  return 'localhost';
}

// Mirrors didwebvh-ts getFileUrl: pathed DID → https://<host>/<segs>/did.jsonl,
// domain-root DID → https://<host>/.well-known/did.jsonl. This is the exact URL
// the resolver GETs (protocol is always https).
function webvhLogUrl(did: string): string {
  const parts = did.split(':'); // did:webvh:<SCID>:<domain>[:<seg>…]
  const domain = decodeURIComponent(parts[3] ?? '');
  const segs = parts.slice(4).map((s) => decodeURIComponent(s));
  const base = `https://${domain}`;
  return segs.length ? `${base}/${segs.join('/')}/did.jsonl` : `${base}/.well-known/did.jsonl`;
}
```

- [ ] **Step 5: Pass the explicit domain to `createDIDWebVH` and resolve after publish**

In `publish()`, change the `createDIDWebVH` call to pass the demo host as `domain`:
```typescript
      const webvh = await this.sdk.did.createDIDWebVH({
        paths: ['studio', 'you']
      });
```
becomes:
```typescript
      const webvh = await this.sdk.did.createDIDWebVH({
        domain: demoHost(),
        paths: ['studio', 'you']
      });
```

Then replace the tail of `publish()`:
```typescript
    await this.sdk.lifecycle.publishToWeb(this.asset, this.publisherDid);
    return this.snapshot();
  }
```
with:
```typescript
    await this.sdk.lifecycle.publishToWeb(this.asset, this.publisherDid);

    // Prove REAL resolution: fetch the just-hosted log back over the network via
    // the SDK's real resolver. skipCache forces a network read (the publisher
    // doc is cached above for offline credential signing). Best-effort in dev
    // (http origin can't satisfy the resolver's hard-coded https), authoritative
    // in prod. resolved=false still shows the link, just no "resolved ✓" tick.
    const logUrl = webvhLogUrl(this.publisherDid);
    let resolvedDoc: unknown = null;
    let resolved = false;
    try {
      resolvedDoc = await this.sdk.did.resolveDID(this.publisherDid, { skipCache: true });
      resolved = !!resolvedDoc;
    } catch (err) {
      log('did:webvh:resolve-failed', err);
    }
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

- [ ] **Step 6: Track the resolution state on the engine and surface it in the snapshot**

Add two fields to the `DemoEngine` class (next to `publisherDid`):
```typescript
  private publisherDid: string | null = null;
```
becomes:
```typescript
  private publisherDid: string | null = null;
  private webvhLogUrl: string | null = null;
  private webvhResolved = false;
```

Extend the `DemoAssetState` interface — add after `btcoDid?: string;`:
```typescript
  webvhDid?: string;
  btcoDid?: string;
```
becomes:
```typescript
  webvhDid?: string;
  webvhLogUrl?: string;
  webvhResolved?: boolean;
  btcoDid?: string;
```

In `snapshot()`, add the two fields to the returned object — after `webvhDid: bindings['did:webvh'],`:
```typescript
      webvhDid: bindings['did:webvh'],
      btcoDid: bindings['did:btco'],
```
becomes:
```typescript
      webvhDid: bindings['did:webvh'],
      webvhLogUrl: this.webvhLogUrl ?? undefined,
      webvhResolved: this.webvhResolved,
      btcoDid: bindings['did:btco'],
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/landing && bun test src/sdk/engine.publish-resolve.test.ts`
Expected: PASS — 1 test passes.

- [ ] **Step 8: Re-run the honesty test to confirm no regression**

Run: `cd apps/landing && bun test src/sdk/engine.summary.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/landing/src/sdk/engine.ts apps/landing/src/sdk/engine.publish-resolve.test.ts
git commit -m "feat(landing): engine hosts did:webvh over HTTP + proves real resolution"
```

---

## Task 6: Demo UI — resolvable link + "resolved ✓" + honest badges

**Files:**
- Modify: `apps/landing/src/content.ts` (add `demo.resolved` copy block)
- Modify: `apps/landing/src/components/Demo.tsx` (render the resolvable link + tick; register the `did:webvh:resolved` event color)
- Modify: `apps/landing/src/components/demo.css` (styles for the new block)
- Test: `apps/landing/src/components/demo-content.test.ts`

**Interfaces:**
- Consumes: `demo` from `../content`; `DemoAssetState` (`webvhLogUrl`, `webvhResolved`) from `../sdk/engine` (Task 5).
- Produces: no new exports; a resolvable-DID panel in the published state.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/components/demo-content.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { demo } from '../content';

describe('demo resolved-DID copy', () => {
  test('has a resolved-DID label block', () => {
    expect(demo.resolved).toBeDefined();
    expect(typeof demo.resolved.heading).toBe('string');
    expect(demo.resolved.heading.length).toBeGreaterThan(0);
    expect(typeof demo.resolved.resolvedBadge).toBe('string');
    expect(typeof demo.resolved.pendingBadge).toBe('string');
    expect(typeof demo.resolved.linkLabel).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/landing && bun test src/components/demo-content.test.ts`
Expected: FAIL — `demo.resolved` is `undefined`.

- [ ] **Step 3: Add the `resolved` copy block to `apps/landing/src/content.ts`**

Inside the `demo` object, add after the `done: { … }` block and before the closing `reset: …`:
```typescript
  done: {
    lead: 'Anchored.',
    beforeSatoshi: 'Inscribed on satoshi',
    beforeTx: 'in tx',
    after: 'The full history is in the Provenance tab.'
  },
```
becomes:
```typescript
  done: {
    lead: 'Anchored.',
    beforeSatoshi: 'Inscribed on satoshi',
    beforeTx: 'in tx',
    after: 'The full history is in the Provenance tab.'
  },
  resolved: {
    heading: 'did:webvh log — live at this origin',
    resolvedBadge: 'resolved ✓',
    pendingBadge: 'resolves in production',
    linkLabel: 'Open the signed DID log',
    note: 'The SDK’s real resolver fetched this over HTTP(S) — no mock. Open it: it’s the signed version history.'
  },
```

- [ ] **Step 4: Register the new event color in `Demo.tsx`**

In `apps/landing/src/components/Demo.tsx`, extend `eventColors`:
```typescript
const eventColors: Record<string, string> = {
  'asset:created': 'var(--peer)',
  'did:webvh:created': 'var(--webvh)',
  'resource:published': 'var(--webvh)',
  'asset:migrated': 'var(--webvh)',
  'credential:issued': 'var(--ok)',
  'asset:inscribed': 'var(--btco)'
};
```
becomes:
```typescript
const eventColors: Record<string, string> = {
  'asset:created': 'var(--peer)',
  'did:webvh:created': 'var(--webvh)',
  'resource:published': 'var(--webvh)',
  'did:webvh:resolved': 'var(--webvh)',
  'asset:migrated': 'var(--webvh)',
  'credential:issued': 'var(--ok)',
  'asset:inscribed': 'var(--btco)'
};
```

- [ ] **Step 5: Render the resolvable-DID panel in the published state**

In `Demo.tsx`, immediately AFTER the `{error && …}` line and BEFORE the `{phase === 'inscribed' && asset && ( … )}` block, insert:

```tsx
                {(phase === 'published' || phase === 'inscribing' || phase === 'inscribed') &&
                  asset?.webvhLogUrl && (
                    <div className="demo-resolved">
                      <div className="demo-resolved-head">
                        <span>{demo.resolved.heading}</span>
                        <span
                          className="demo-resolved-badge"
                          data-ok={asset.webvhResolved || undefined}
                        >
                          {asset.webvhResolved
                            ? demo.resolved.resolvedBadge
                            : demo.resolved.pendingBadge}
                        </span>
                      </div>
                      <a
                        className="demo-resolved-link"
                        href={asset.webvhLogUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {demo.resolved.linkLabel}
                        <code>{asset.webvhLogUrl}</code>
                      </a>
                      <p className="demo-resolved-note">{demo.resolved.note}</p>
                    </div>
                  )}
```

- [ ] **Step 6: Add styles to `apps/landing/src/components/demo.css`**

Append to the end of `apps/landing/src/components/demo.css`:

```css
.demo-resolved {
  margin-top: 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 10px;
  background: color-mix(in srgb, var(--webvh) 6%, transparent);
}
.demo-resolved-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-weight: 600;
  font-size: 0.9rem;
}
.demo-resolved-badge {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  color: var(--text-tertiary, #888);
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.demo-resolved-badge[data-ok] {
  color: var(--ok, #1a8f4a);
}
.demo-resolved-link {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  margin-top: 0.5rem;
  font-size: 0.85rem;
  text-decoration: none;
}
.demo-resolved-link code {
  font-size: 0.75rem;
  word-break: break-all;
  color: var(--webvh);
}
.demo-resolved-note {
  margin-top: 0.5rem;
  font-size: 0.78rem;
  color: var(--text-tertiary, #888);
}
```

- [ ] **Step 7: Run the content test to verify it passes**

Run: `cd apps/landing && bun test src/components/demo-content.test.ts`
Expected: PASS — 1 test passes.

- [ ] **Step 8: Full app + engine test sweep (no regressions)**

Run: `cd apps/landing && bun test server/tests/app.test.ts server/tests/webvh-host.test.ts server/tests/router.test.ts src/sdk/http-hosting-adapter.test.ts src/sdk/engine.summary.test.ts src/sdk/engine.publish-resolve.test.ts src/components/demo-content.test.ts`
Expected: PASS — all suites green.

- [ ] **Step 9: Manual smoke (dev)**

Run in one terminal: `cd apps/landing && bun run serve.ts` (unified server on :8787; logs "auth unconfigured" — expected without secrets). In another: `cd apps/landing && bun run dev` (Vite). Open the demo, click Create → Publish. Confirm: the event log shows `did:webvh:resolved`; the resolvable-DID panel renders with the `https://localhost:5173/studio/you/did.jsonl` link and the "resolves in production" badge (dev is http, so resolution is best-effort — the badge NOT showing "resolved ✓" in dev is correct per Resolved fact #4). Confirm no console errors from the hosting PUTs (they should 200 via the Vite `/api` proxy).

- [ ] **Step 10: Commit**

```bash
git add apps/landing/src/content.ts apps/landing/src/components/Demo.tsx apps/landing/src/components/demo.css apps/landing/src/components/demo-content.test.ts
git commit -m "feat(landing): show resolvable did:webvh log + resolved indicator"
```

---

## Self-review notes (done before saving)

- **Spec coverage (Phase 0 + Track A):**
  - Unified server (SPA + SPA-fallback + traversal guard + `/api/*` + conditional auth + `/api/host/*` + webvh GET mounts) → Task 1. Railway `startCommand` → Task 1 Step 7. Dev proxy kept → Task 1 Step 8.
  - Auth mounting conditional on `JWT_SECRET` + `TURNKEY_*`, no throw when absent, 503 stubs → Task 1 (`buildStubRoutes`) + `serve.ts`.
  - did:peer→did:cel + hosted-storage wording, plus create/publish `content.ts` copy → Task 2.
  - `HttpHostingStorageAdapter` (interface A `put`/`get`) over `PUT`/`GET /api/host/*` → Task 3.
  - `webvh-host.ts` in-memory Map + size cap + entry cap + TTL + rate limit, serves at resolver URLs → Task 4.
  - Engine: swap adapter, explicit `domain`, post-publish `resolveDID`, new `did:webvh:resolved` event with log URL + doc → Task 5.
  - UI: resolvable link + "resolved ✓" + honest badges → Task 6.
  - Testing plan (server units, adapter mock-fetch, engine publish→resolve integration) → Tasks 1/3/4/5.
- **Explicitly out of scope (Track B / Plan 2), untouched here:** `HttpOrdinalsProvider`, `TurnkeySatSigner`, `bitcoin.ts` faucet/QuickNode proxy, user Bitcoin-account provisioning, `network: 'testnet'`, inscription copy. `OrdMockProvider` and `inscribe()` left as-is.
- **Placeholder scan:** every code step contains complete code; no TODO/TBD/"add error handling"; all test commands are exact `cd apps/landing && bun test <path>` with expected PASS/FAIL.
- **Type/name consistency:** `WebvhHostStore` two-method surface (`handlePut`/`serve`) is identical in Task 1 (`app.ts`) and Task 4 (`webvh-host.ts`). `createWebvhHostStore` name matches across `serve.ts` (Task 1), `webvh-host.ts` (Task 4), and the engine integration test (Task 5). `HttpHostingStorageAdapter` (`put`/`get`) matches across Tasks 3 and 5. `webvhLogUrl`/`demoHost` defined and used only within Task 5. `did:webvh:resolved` event payload `{ logUrl, resolved, doc }` matches between the emit (Task 5), the integration test (Task 5), and the UI consumption via `DemoAssetState.webvhLogUrl`/`webvhResolved` (Tasks 5 + 6). `buildStubRoutes` exported from `server/index.ts` (Task 1) and imported by `serve.ts` (Task 1) and `app.test.ts` (Task 1).
