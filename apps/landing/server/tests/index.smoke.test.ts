import { describe, test, expect } from 'bun:test';
import { createInMemorySessionStorage } from '@originals/auth/server';
import { buildRoutes } from '../index';
import { route } from '../router';

describe('index route table', () => {
  test('health + auth routes are registered', async () => {
    process.env.JWT_SECRET = 'test-secret-0123456789-0123456789';
    const routes = buildRoutes({
      turnkey: { apiClient: () => ({}) } as any,
      sessions: createInMemorySessionStorage(),
      jwtSecret: 'test-secret-0123456789-0123456789',
    });
    const health = await route(new Request('http://x/api/health'), routes);
    expect(health.status).toBe(200);
    const me = await route(new Request('http://x/api/me'), routes);
    expect(me.status).toBe(401); // registered, and unauthenticated
  });
});
