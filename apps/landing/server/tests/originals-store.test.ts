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

  test('recordOriginal is idempotent on a duplicate did (best-effort retry)', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const o = { did: 'did:webvh:S:h:a', title: 'A', resourceHash: 'x', createdAt: 't' };
    store.recordOriginal('sub-1', o);
    store.recordOriginal('sub-1', { ...o, title: 'A (retry)' }); // same did, ignored
    const list = store.list('sub-1');
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('A'); // first write wins, no duplicate
  });

  test('first-writer-wins: another user cannot overwrite an object, the owner can', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const key = 'demo.example.com/user-sub-1/abc/did.jsonl';
    store.saveBytes('sub-1', key, enc('A'), 'application/jsonl');
    expect(() => store.saveBytes('sub-2', key, enc('B'), 'application/jsonl')).toThrow('FORBIDDEN');
    // The owner may still re-write their own object.
    expect(() => store.saveBytes('sub-1', key, enc('A2'), 'application/jsonl')).not.toThrow();
    // sub-1's bytes stand; sub-2 never clobbered them.
    expect(store.serve(new URL('http://demo.example.com/user-sub-1/abc/did.jsonl'))!.status).toBe(200);
  });

  test('read: auth-scoped get by key returns the bytes with anti-XSS headers', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const key = 'demo.example.com/studio/you/abc/did.jsonl';
    store.saveBytes('sub-1', key, enc('{"v":1}'), 'application/jsonl');
    const res = store.read('sub-1', key);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/jsonl');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('read: 404 for a key the user never wrote (and never another user’s key)', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const key = 'demo.example.com/studio/you/abc/did.jsonl';
    store.saveBytes('sub-1', key, enc('{"v":1}'), 'application/jsonl');
    expect(store.read('sub-1', 'demo.example.com/nope/did.jsonl').status).toBe(404);
    // sub-2 wrote nothing → cannot read sub-1's key.
    expect(store.read('sub-2', key).status).toBe(404);
  });

  test('quota: exceeding total bytes throws STORE_FULL', () => {
    const store = createOriginalsStore({ dataDir: tmpDir(), maxTotalBytes: 8 });
    expect(() =>
      store.saveBytes('sub-1', 'h/a/did.jsonl', enc('this is longer than eight bytes'), 'application/jsonl')
    ).toThrow('STORE_FULL');
  });
});
