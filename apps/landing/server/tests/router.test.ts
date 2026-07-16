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
