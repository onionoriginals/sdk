/**
 * SEC-1 — the auth cookie must not lose `Secure` because nobody set NODE_ENV.
 *
 * `getAuthCookieConfig` computes `secure: options?.secure ?? isProduction` from
 * `NODE_ENV === 'production'`, and the deploy doc says the platform does not set
 * NODE_ENV. The boot contract catches it, but is warn-only by default. The
 * cookie is a 7-day JWT that gates every money route, so it is pinned here
 * against the real serialized header — with NODE_ENV explicitly absent.
 *
 * Only `verifyEmailAuth` and `signToken` are stubbed: the cookie config and
 * `serializeCookie` are the real ones, which is the whole point.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import * as realAuthServer from '@originals/auth/server';

const realExports = { ...realAuthServer };
afterAll(() => {
  mock.module('@originals/auth/server', () => realExports);
});
mock.module('@originals/auth/server', () => ({
  ...realExports,
  initiateEmailAuth: async () => ({ sessionId: 's1', message: 'sent' }),
  verifyEmailAuth: async () => ({
    verified: true,
    subOrgId: 'sub-1',
    email: 'a@b.com',
    verificationToken: 'vtoken-123',
  }),
  signToken: () => 'jwt-token',
}));

const { createAuthRoutes } = await import('../auth-routes');

function routes() {
  return createAuthRoutes({
    turnkey: {} as unknown as Parameters<typeof createAuthRoutes>[0]['turnkey'],
    sessions: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      cleanup: () => {},
    } as unknown as Parameters<typeof createAuthRoutes>[0]['sessions'],
    jwtSecret: 'test-secret-at-least-32-chars-long!!',
  });
}

async function verifyOtpCookie(): Promise<string> {
  const req = new Request('http://x/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', code: '123456' }),
  });
  const res = await routes().verifyOtp(req, new URL(req.url), '203.0.113.50');
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

describe('the verify-otp session cookie', () => {
  test('carries Secure with NODE_ENV unset — the state the platform actually deploys in', async () => {
    const restore = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const cookie = await verifyOtpCookie();
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
    } finally {
      if (restore !== undefined) process.env.NODE_ENV = restore;
    }
  });

  test('logout clears it with the same flags — a clear must not downgrade the channel', async () => {
    const restore = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const res = await routes().logout(
        new Request('http://x/api/auth/logout', { method: 'POST' }),
        new URL('http://x/api/auth/logout')
      );
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('HttpOnly');
    } finally {
      if (restore !== undefined) process.env.NODE_ENV = restore;
    }
  });
});
