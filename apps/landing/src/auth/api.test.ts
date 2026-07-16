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
