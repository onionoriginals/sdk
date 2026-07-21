import { describe, test, expect, mock, afterAll } from 'bun:test';
import * as realAuthServer from '@originals/auth/server';

// Stub the auth/server module so verify-otp's success path is deterministic
// without real OTP crypto. verifyEmailAuth returns the client-bound token; the
// other exports are minimal real-shaped stubs (serializeCookie from ./cookies
// is real and consumes getAuthCookieConfig's output). RESTORED in afterAll so
// the mock doesn't leak into sibling test files (bun shares the module registry
// across a run).
const realExports = { ...realAuthServer };
afterAll(() => {
  mock.module('@originals/auth/server', () => realExports);
});
mock.module('@originals/auth/server', () => ({
  initiateEmailAuth: async () => ({ sessionId: 's1', message: 'sent' }),
  verifyEmailAuth: async (
    _sessionId: string,
    _code: string,
    _turnkey: unknown,
    _sessions: unknown,
    opts?: { publicKey?: string }
  ) => ({
    verified: true,
    subOrgId: 'sub-1',
    email: 'a@b.com',
    verificationToken: 'vtoken-123',
    publicKey: opts?.publicKey,
  }),
  signToken: () => 'jwt-token',
  verifyToken: () => ({ sub: 'sub-1', email: 'a@b.com' }),
  getAuthCookieConfig: (token: string) => ({
    name: 'auth_token',
    value: token,
    options: { httpOnly: true, path: '/' },
  }),
  getClearAuthCookieConfig: () => ({
    name: 'auth_token',
    value: '',
    options: { maxAge: 0, path: '/' },
  }),
}));

const { createAuthRoutes } = await import('../auth-routes');

function deps() {
  return {
    turnkey: {} as unknown as Parameters<typeof createAuthRoutes>[0]['turnkey'],
    sessions: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      cleanup: () => {},
    } as unknown as Parameters<typeof createAuthRoutes>[0]['sessions'],
    jwtSecret: 'test-secret-at-least-32-chars-long!!',
  };
}

describe('verify-otp surfaces the client-bound verificationToken', () => {
  test('response body carries verificationToken + publicKey alongside subOrgId', async () => {
    const routes = createAuthRoutes(deps());
    const req = new Request('http://x/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', code: '123456', publicKey: '02'.padEnd(66, 'a') }),
    });
    const res = await routes.verifyOtp(req, new URL(req.url));
    expect(res.status).toBe(200);
    // The httpOnly JWT cookie is still set; the body now also returns the token.
    expect(res.headers.get('set-cookie')).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.subOrgId).toBe('sub-1');
    expect(body.verificationToken).toBe('vtoken-123');
    expect(body.publicKey).toBe('02'.padEnd(66, 'a'));
  });
});
