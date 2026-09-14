import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createOriginalsStore } from '../originals-store';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'originals-store-'));
}
const enc = (s: string) => new TextEncoder().encode(s);

/** Path to a hosted key's on-disk bytes file, mirroring the store's internal layout. */
function hostedPath(dataDir: string, key: string): string {
  return join(dataDir, 'hosted', ...key.split('/'));
}

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

  test('serve returns null (no EISDIR) when the key resolves to a directory, e.g. "/"', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    // Host something so `hosted/demo.example.com/...` (and its parent dir) exist.
    store.saveBytes('sub-1', 'demo.example.com/studio/you/abc/did.jsonl', enc('{}'), 'application/jsonl');
    // Pathname '/' → key 'demo.example.com/' → resolves to the host DIRECTORY.
    // Must be a clean miss (falls through to the SPA), never a readFileSync crash.
    expect(store.serve(new URL('http://demo.example.com/'))).toBeNull();
    // An intermediate directory in the hosted tree is likewise a miss.
    expect(store.serve(new URL('http://demo.example.com/studio/you/abc'))).toBeNull();
  });

  test('read returns 404 (no EISDIR) for a key that maps to a directory', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    store.saveBytes('sub-1', 'demo.example.com/studio/you/abc/did.jsonl', enc('{}'), 'application/jsonl');
    // A bare-directory key is a 404 — the user index never records it, and the
    // fs guard would also reject it as a non-file — so read never EISDIRs.
    expect(store.read('sub-1', 'demo.example.com/studio/you/abc').status).toBe(404);
  });

  test('unverified storage sidecars cannot invent a resource cover', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const did = 'did:webvh:SCID:demo.example.com:studio:you:abc';
    store.saveBytes('sub-1', 'demo.example.com/studio/you/abc/resources/fake', enc('not authenticated'), 'image/png');
    store.recordOriginal('sub-1', { did, title: 'Piece', resourceHash: 'deadbeef', createdAt: '2026-07-21T00:00:00.000Z' });
    const [row] = store.list('sub-1');
    expect(row.resourceUrl).toBeUndefined();
    expect(row.resourceContentType).toBeUndefined();
  });

  test('a missing content-type sidecar leaves the type unknown rather than guessing', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const did = 'did:webvh:SCID:demo.example.com:studio:you:none';
    store.recordOriginal('sub-1', { did, title: 'Bare', resourceHash: 'f00d', createdAt: '2026-07-21T00:00:00.000Z' });

    const [row] = store.list('sub-1');
    expect(row.resourceUrl).toBeUndefined();
    expect(row.resourceContentType).toBeUndefined();
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

  test('orphaned bytes with no owner marker fail closed for every caller, including the original writer', () => {
    // Simulates the crash window this store must close: resource bytes on
    // disk (e.g. from a pre-fix crash, or filesystem corruption) with no
    // `.owner` sidecar. #690: this must never be silently claimable by
    // whichever subOrgId happens to write next — not even the original owner,
    // since there is no way to verify who that was once the marker is gone.
    const dataDir = tmpDir();
    const store = createOriginalsStore({ dataDir });
    const key = 'demo.example.com/user-sub-1/abc/did.jsonl';
    const path = hostedPath(dataDir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'orphaned bytes, no .owner sidecar');

    expect(() => store.saveBytes('sub-1', key, enc('mine'), 'application/jsonl')).toThrow(
      'INCONSISTENT_OWNERSHIP'
    );
    expect(() => store.saveBytes('sub-2', key, enc('attacker'), 'application/jsonl')).toThrow(
      'INCONSISTENT_OWNERSHIP'
    );
    // Neither call touched the orphaned bytes.
    expect(readFileSync(path, 'utf8')).toBe('orphaned bytes, no .owner sidecar');
  });

  test('a crash after the owner claim but before bytes leaves a resumable, still-protected write', () => {
    // Simulates the other half of the crash window: the owner marker is
    // written (the new commit point) but the process dies before the bytes
    // ever land. The rightful owner must be able to resume; nobody else may.
    const dataDir = tmpDir();
    const store = createOriginalsStore({ dataDir });
    const key = 'demo.example.com/user-sub-1/abc/did.jsonl';
    const path = hostedPath(dataDir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + '.owner', 'sub-1');
    expect(existsSync(path)).toBe(false);

    expect(() => store.saveBytes('sub-2', key, enc('attacker'), 'application/jsonl')).toThrow('FORBIDDEN');
    expect(existsSync(path)).toBe(false); // still never written

    expect(() => store.saveBytes('sub-1', key, enc('resumed'), 'application/jsonl')).not.toThrow();
    expect(store.serve(new URL('http://demo.example.com/user-sub-1/abc/did.jsonl'))!.status).toBe(200);
  });

  test('the per-user index survives a stray leftover temp file from an interrupted write', () => {
    // atomicWriteFile writes to a uniquely-named `.tmp` sibling before the
    // rename; a crash before the rename leaves that sibling behind. It must
    // never be mistaken for the real index file.
    const dataDir = tmpDir();
    const store = createOriginalsStore({ dataDir });
    store.recordOriginal('sub-1', { did: 'did:webvh:S:h:a', title: 'A', resourceHash: 'x', createdAt: 't' });
    const usersDir = join(dataDir, 'users');
    writeFileSync(join(usersDir, 'sub-1.json.stray.tmp'), 'not valid json{{{');

    expect(store.list('sub-1').map((o) => o.title)).toEqual(['A']);
    // Cleanup is irrelevant to the assertion above; keep the dir tidy anyway.
    rmSync(join(usersDir, 'sub-1.json.stray.tmp'));
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

  test('recordOriginal upsert-merges inscription fields onto an existing did (no duplicate row)', () => {
    const store = createOriginalsStore({ dataDir: tmpDir() });
    const base = {
      did: 'did:webvh:S:h:studio:you:abc',
      title: 'Piece',
      resourceHash: 'aa'.repeat(32),
      createdAt: '2026-08-18T00:00:00.000Z',
    };
    store.recordOriginal('sub-1', base);
    // Second post — after the did:btco migrate — enriches the SAME row.
    store.recordOriginal('sub-1', {
      ...base,
      title: 'IGNORED — identity fields are set once',
      btcoDid: 'did:btco:123',
      inscriptionId: 'i'.repeat(64) + 'i0',
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      satoshi: '123',
      inscriptionStatus: 'pending',
    });
    const rows = store.list('sub-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Piece'); // identity untouched
    expect(rows[0].btcoDid).toBe('did:btco:123');
    expect(rows[0].inscriptionStatus).toBe('pending');
    // A later status-only merge flips pending → confirmed, keeping the rest.
    store.recordOriginal('sub-1', { ...base, inscriptionStatus: 'confirmed' });
    expect(store.list('sub-1')[0].inscriptionStatus).toBe('confirmed');
    expect(store.list('sub-1')[0].satoshi).toBe('123');
  });

  test('quota: exceeding total bytes throws STORE_FULL', () => {
    const store = createOriginalsStore({ dataDir: tmpDir(), maxTotalBytes: 8 });
    expect(() =>
      store.saveBytes('sub-1', 'h/a/did.jsonl', enc('this is longer than eight bytes'), 'application/jsonl')
    ).toThrow('STORE_FULL');
  });
});
