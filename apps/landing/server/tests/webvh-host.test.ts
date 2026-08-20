import { describe, test, expect } from 'bun:test';
import { createWebvhHostStore, publishGroupOf } from '../webvh-host';

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

  test('served content is neutralized against stored XSS', async () => {
    const store = createWebvhHostStore();
    // An attacker PUTs active HTML with an arbitrary content-type.
    const key = 'victim.example.com/evil/did.jsonl';
    await store.handlePut(
      putReq(key, '<script>alert(document.cookie)</script>', 'text/html'),
      new URL(`http://host/api/host/${encodeURIComponent(key)}`)
    );
    const url = new URL('http://victim.example.com/evil/did.jsonl');
    const served = store.serve(new Request(url), url)!;
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
    expect(served.headers.get('content-disposition')).toBe('attachment');
  });

  test('read() (GET /api/host/*) also carries the anti-XSS headers', async () => {
    const store = createWebvhHostStore();
    const key = 'victim.example.com/evil/did.jsonl';
    await store.handlePut(
      putReq(key, '<script>alert(1)</script>', 'text/html'),
      new URL(`http://host/api/host/${encodeURIComponent(key)}`)
    );
    const url = new URL(`http://host/api/host/${encodeURIComponent(key)}`);
    const res = store.read(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-disposition')).toBe('attachment');
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


  test('rate limit keys on the passed socket IP, not a spoofable X-Forwarded-For', async () => {
    const store = createWebvhHostStore({ limit: 1, windowMs: 60_000 });
    const mk = (k: string, xff: string) =>
      new Request(`http://host/api/host/${encodeURIComponent(k)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/jsonl', 'x-forwarded-for': xff },
        body: 'x',
      });
    const u = (k: string) => new URL(`http://host/api/host/${encodeURIComponent(k)}`);

    const first = await store.handlePut(mk('a/x/did.jsonl', '9.9.9.9'), u('a/x/did.jsonl'), '1.1.1.1');
    expect(first.status).toBe(200);
    // Same real IP, a DIFFERENT spoofed X-Forwarded-For → still the same bucket → limited.
    const second = await store.handlePut(mk('b/x/did.jsonl', '8.8.8.8'), u('b/x/did.jsonl'), '1.1.1.1');
    expect(second.status).toBe(429);
    // A genuinely different socket IP gets its own bucket.
    const other = await store.handlePut(mk('c/x/did.jsonl', '7.7.7.7'), u('c/x/did.jsonl'), '2.2.2.2');
    expect(other.status).toBe(200);
  });

  test('non-PUT method is rejected 405', async () => {
    const store = createWebvhHostStore();
    const url = new URL('http://host/api/host/whatever');
    const res = await store.handlePut(new Request(url, { method: 'POST' }), url);
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Per-client, publish-group eviction (R15). The old behaviour was a hard 507 at
// a global entry cap: the first flood took the demo down for every visitor.
// ---------------------------------------------------------------------------

const u = (k: string) => new URL(`http://host/api/host/${encodeURIComponent(k)}`);

function put(
  store: ReturnType<typeof createWebvhHostStore>,
  key: string,
  client = '1.1.1.1',
  body = 'x'
) {
  return store.handlePut(putReq(key, body, 'application/jsonl'), u(key), client);
}

const hit = (store: ReturnType<typeof createWebvhHostStore>, key: string) =>
  store.read(u(key)).status === 200;

describe('webvh-host publish groups', () => {
  test('every object of one did:webvh publish shares a group', () => {
    expect(publishGroupOf('demo.test/u/alice/did.jsonl')).toBe('demo.test/u/alice');
    expect(publishGroupOf('demo.test/u/alice/cel.json')).toBe('demo.test/u/alice');
    expect(publishGroupOf('demo.test/u/alice/resources/zAbC')).toBe('demo.test/u/alice');
  });

  test('a domain-root DID groups its .well-known log with its resources', () => {
    expect(publishGroupOf('demo.test/.well-known/did.jsonl')).toBe('demo.test');
    expect(publishGroupOf('demo.test/.well-known/did.json')).toBe('demo.test');
    expect(publishGroupOf('demo.test/resources/zAbC')).toBe('demo.test');
  });

  test('an unrecognised key is its own group, never folded into a neighbour', () => {
    expect(publishGroupOf('cel/uEiAbC.json')).toBe('cel/uEiAbC.json');
    expect(publishGroupOf('whatever')).toBe('whatever');
  });
});

describe('webvh-host eviction', () => {
  test('a client at its own cap evicts its own LRU group and accepts the write', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 4 });
    await put(store, 'd/a1/did.jsonl');
    await put(store, 'd/a1/cel.json');
    await put(store, 'd/a2/did.jsonl');
    await put(store, 'd/a2/cel.json');

    const res = await put(store, 'd/a3/did.jsonl');
    expect(res.status).toBe(200);
    expect(hit(store, 'd/a3/did.jsonl')).toBe(true);
    // The oldest publish went, whole.
    expect(hit(store, 'd/a1/did.jsonl')).toBe(false);
    expect(hit(store, 'd/a1/cel.json')).toBe(false);
    expect(hit(store, 'd/a2/did.jsonl')).toBe(true);
  });

  test('a full store accepts the next write instead of answering 507', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 1 });
    expect((await put(store, 'a/x/did.jsonl')).status).toBe(200);
    expect((await put(store, 'b/x/did.jsonl')).status).toBe(200);
  });

  test('one client flooding never evicts another client’s published log', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 2 });
    await put(store, 'victim.test/v/did.jsonl', '2.2.2.2', 'the victim log');
    for (let i = 0; i < 30; i++) {
      await put(store, `flood.test/f${i}/did.jsonl`, '1.1.1.1');
    }
    const url = new URL('http://victim.test/v/did.jsonl');
    const served = store.serve(new Request(url), url);
    expect(served).not.toBeNull();
    expect(await served!.text()).toBe('the victim log');
  });

  test('an evicted entry reads as a clean miss, not an error', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 1 });
    await put(store, 'd/g1/did.jsonl');
    await put(store, 'd/g2/did.jsonl');

    const res = store.read(u('d/g1/did.jsonl'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    const url = new URL('http://d/g1/did.jsonl');
    expect(store.serve(new Request(url), url)).toBeNull();
  });

  test('a recently READ group is not the one evicted', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 2 });
    await put(store, 'd/g1/did.jsonl');
    await put(store, 'd/g2/did.jsonl');
    expect(hit(store, 'd/g1/did.jsonl')).toBe(true); // g1 is now the most recent

    await put(store, 'd/g3/did.jsonl');
    expect(hit(store, 'd/g1/did.jsonl')).toBe(true);
    expect(hit(store, 'd/g2/did.jsonl')).toBe(false);
  });

  test('a recently SERVED group is not the one evicted', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 2 });
    await put(store, 'd/g1/did.jsonl');
    await put(store, 'd/g2/did.jsonl');
    const url = new URL('http://d/g1/did.jsonl');
    expect(store.serve(new Request(url), url)).not.toBeNull();

    await put(store, 'd/g3/did.jsonl');
    expect(hit(store, 'd/g1/did.jsonl')).toBe(true);
    expect(hit(store, 'd/g2/did.jsonl')).toBe(false);
  });

  test('eviction is all-or-nothing: a surviving log never points at gone bytes', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 3 });
    const groupA = ['d/u/a/did.jsonl', 'd/u/a/cel.json', 'd/u/a/resources/zAbC'];
    for (const k of groupA) await put(store, k);
    await put(store, 'd/u/b/did.jsonl');

    const survivors = groupA.filter((k) => hit(store, k));
    expect(survivors).toEqual([]);
  });

  test('a single publish bigger than the cap takes itself down, not a neighbour', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 2 });
    await put(store, 'other.test/o/did.jsonl', '2.2.2.2');
    // One group, four objects, one client: the group restarts rather than
    // leaving a log whose resources are gone.
    await put(store, 'd/u/a/did.jsonl');
    await put(store, 'd/u/a/cel.json');
    await put(store, 'd/u/a/resources/z1');
    await put(store, 'd/u/a/resources/z2');
    expect(hit(store, 'other.test/o/did.jsonl')).toBe(true);
    expect(hit(store, 'd/u/a/resources/z2')).toBe(true);
  });

  test('entries still expire on the TTL, independently of eviction', async () => {
    let clock = 1000;
    const store = createWebvhHostStore({ maxEntriesPerClient: 50, ttlMs: 500, now: () => clock });
    await put(store, 'd/g1/did.jsonl');
    expect(hit(store, 'd/g1/did.jsonl')).toBe(true);
    clock += 501;
    expect(hit(store, 'd/g1/did.jsonl')).toBe(false);
    // …and the expired entry frees the writer's budget again.
    await put(store, 'd/g2/did.jsonl');
    expect(store.stats().entries).toBe(1);
  });

  test('the global entry cap bounds a distributed flood without a 507', async () => {
    const store = createWebvhHostStore({ maxEntries: 4, maxEntriesPerClient: 4 });
    for (let i = 0; i < 12; i++) {
      const res = await put(store, `d/g${i}/did.jsonl`, `10.0.0.${i}`);
      expect(res.status).toBe(200);
    }
    expect(store.stats().entries).toBeLessThanOrEqual(4);
    expect(hit(store, 'd/g11/did.jsonl')).toBe(true); // the newest writer survives
  });

  test('the per-client bookkeeping map is bounded too', async () => {
    const store = createWebvhHostStore({ maxClients: 3 });
    for (let i = 0; i < 12; i++) await put(store, `d/g${i}/did.jsonl`, `10.0.0.${i}`);
    expect(store.stats().clients).toBeLessThanOrEqual(3);
  });

  test('a total-bytes budget bounds memory regardless of entry count', async () => {
    const store = createWebvhHostStore({ maxTotalBytes: 40, maxEntriesPerClient: 100 });
    for (let i = 0; i < 12; i++) await put(store, `d/g${i}/did.jsonl`, '1.1.1.1', '0123456789');
    expect(store.stats().bytes).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// R5: the group is the unit of OWNERSHIP, not just of eviction. A publish whose
// members were written from two client identities — a visitor on mobile or IPv6
// whose egress address rotates between the initial publish and a revision, which
// is exactly what the retitle→commit edit loop does — must still evict whole.
// ---------------------------------------------------------------------------

/**
 * The read-time invariant the whole-group rule exists to enforce: if a DID log
 * survived any eviction sequence, every resource of the same publish survived
 * too. Returns the resource keys that a surviving log now points at in vain.
 */
function orphanedResources(
  store: ReturnType<typeof createWebvhHostStore>,
  written: string[]
): string[] {
  const alive = new Set(written.filter((k) => hit(store, k)));
  const orphans = new Set<string>();
  for (const log of written) {
    if (!log.endsWith('/did.jsonl') || !alive.has(log)) continue;
    const group = publishGroupOf(log);
    for (const k of written) {
      if (k.includes('/resources/') && publishGroupOf(k) === group && !alive.has(k)) {
        orphans.add(k);
      }
    }
  }
  return [...orphans];
}

describe('webvh-host cross-identity publish groups', () => {
  const alice = ['d/u/alice/did.jsonl', 'd/u/alice/resources/r1'];

  test('a revision from a second IP does not split the publish across two budgets', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 2 });
    await put(store, 'd/u/alice/did.jsonl', 'A');
    await put(store, 'd/u/alice/resources/r1', 'A');
    // Same visitor, rotated egress address, revising her own log.
    await put(store, 'd/u/alice/did.jsonl', 'B');

    // …then the ORIGINAL identity fills its budget.
    const written = [...alice, 'd/u/other/did.jsonl', 'd/u/other/cel.json'];
    await put(store, 'd/u/other/did.jsonl', 'A');
    await put(store, 'd/u/other/cel.json', 'A');

    expect(orphanedResources(store, written)).toEqual([]);
    // Whichever way it went, the publish shared one fate.
    expect(hit(store, 'd/u/alice/resources/r1')).toBe(hit(store, 'd/u/alice/did.jsonl'));
  });

  test('…and the same holds when the SECOND identity is the one that floods', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 2 });
    await put(store, 'd/u/alice/did.jsonl', 'A');
    await put(store, 'd/u/alice/resources/r1', 'A');
    await put(store, 'd/u/alice/did.jsonl', 'B');

    const written = [...alice, 'd/u/bob/did.jsonl', 'd/u/bob/cel.json'];
    await put(store, 'd/u/bob/did.jsonl', 'B');
    await put(store, 'd/u/bob/cel.json', 'B');

    expect(orphanedResources(store, written)).toEqual([]);
    expect(hit(store, 'd/u/alice/resources/r1')).toBe(hit(store, 'd/u/alice/did.jsonl'));
  });

  test('no eviction sequence leaves a resolvable log pointing at gone bytes', async () => {
    const store = createWebvhHostStore({ maxEntriesPerClient: 6 });
    const written: string[] = [];
    const ips = ['A', 'B', 'C'];
    for (const [p, ip] of ips.entries()) {
      const members = [
        `d/u/p${p}/did.jsonl`,
        `d/u/p${p}/cel.json`,
        `d/u/p${p}/resources/r${p}a`,
        `d/u/p${p}/resources/r${p}b`,
      ];
      written.push(...members);
      for (const k of members) await put(store, k, ip);
      // The log alone is revised after an address rotation — the shape that used
      // to leave the log on one budget and its resources on another.
      await put(store, `d/u/p${p}/did.jsonl`, 'R');
    }
    // Every original identity then keeps working until its own budget evicts.
    for (const ip of ips) {
      for (let j = 0; j < 5; j++) await put(store, `d/u/${ip}extra${j}/did.jsonl`, ip);
    }

    expect(orphanedResources(store, written)).toEqual([]);
  });
});
