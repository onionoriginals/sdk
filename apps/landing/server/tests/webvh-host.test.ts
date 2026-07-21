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
