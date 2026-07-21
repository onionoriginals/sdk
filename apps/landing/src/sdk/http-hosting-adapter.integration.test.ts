import { describe, test, expect } from 'bun:test';
import { HttpHostingStorageAdapter } from './http-hosting-adapter';
import { buildFetch } from '../../server/app';
import { createWebvhHostStore } from '../../server/webvh-host';

// Exercises the REAL server dispatch (buildFetch + createWebvhHostStore), not a
// hand-mocked fetch — this is the path that a unit-level mock hides. Regression
// for: GET /api/host/* was routed to handlePut (PUT-only → 405), so adapter.get
// threw against the real server instead of returning content / null.
function adapterOverRealServer() {
  const store = createWebvhHostStore();
  const fetchFn = buildFetch({ apiRoutes: null, hostStore: store, distDir: '/nonexistent/' });
  // The adapter uses same-origin relative URLs (as in the browser); resolve
  // them against a base origin so Request can be constructed in the test env.
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.toString();
    return fetchFn(new Request(new URL(raw, 'http://demo.local'), init));
  }) as unknown as typeof fetch;
  return new HttpHostingStorageAdapter({ baseUrl: '', fetchImpl });
}

describe('HttpHostingStorageAdapter against the real server', () => {
  test('put then get roundtrips (get does not throw)', async () => {
    const adapter = adapterOverRealServer();
    const key = 'demo.example.com/studio/you/did.jsonl';
    await adapter.put(key, '{"v":1}', { contentType: 'application/jsonl' });
    const got = await adapter.get(key);
    expect(got).not.toBeNull();
    expect(got!.content.toString()).toBe('{"v":1}');
    expect(got!.contentType).toBe('application/jsonl');
  });

  test('get returns null on a miss (404, not a throw)', async () => {
    const adapter = adapterOverRealServer();
    expect(await adapter.get('demo.example.com/never/did.jsonl')).toBeNull();
  });
});
