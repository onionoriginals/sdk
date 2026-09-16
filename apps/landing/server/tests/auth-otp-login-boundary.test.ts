/**
 * #708 — verify-otp must never surface OTP_LOGIN material the caller can't
 * act on.
 *
 * `verifyEmailAuth` returns a `verificationToken` bound to a P-256 public
 * key: either the client's own (supplied via request `publicKey`), or, when
 * omitted, a server-generated ephemeral keypair whose `privateKey` is only
 * meant to transit this response as a server-only fallback (see
 * `packages/auth/src/types.ts`'s `VerifyAuthResult.privateKey`). Returning a
 * token bound to a key the caller never received is a dead end that still
 * reports `verified: true`; returning the ephemeral `privateKey` itself over
 * HTTP would be a live leak of sensitive key material. This route must do
 * neither: when the request supplied its own `publicKey`, echo the token +
 * that public key; otherwise, report cookie-auth only.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import * as realAuthServer from '@originals/auth/server';

const realExports = { ...realAuthServer };
afterAll(() => {
  mock.module('@originals/auth/server', () => realExports);
});

const CLIENT_PUBLIC_KEY = '02' + 'aa'.repeat(32);
const SERVER_PUBLIC_KEY = '02' + 'bb'.repeat(32);
const SERVER_PRIVATE_KEY = 'DEADBEEF'.repeat(8);

mock.module('@originals/auth/server', () => ({
  ...realExports,
  initiateEmailAuth: async () => ({ sessionId: 's1', message: 'sent' }),
  // Mirrors verifyEmailAuth's real contract: publicKey is echoed back when
  // the caller supplied one; privateKey is only ever present when it didn't.
  verifyEmailAuth: async (
    _sessionId: string,
    _code: string,
    _turnkey: unknown,
    _sessions: unknown,
    options?: { publicKey?: string }
  ) =>
    options?.publicKey
      ? {
          verified: true,
          subOrgId: 'sub-1',
          email: 'a@b.com',
          verificationToken: 'vtoken-client-bound',
          publicKey: options.publicKey,
        }
      : {
          verified: true,
          subOrgId: 'sub-1',
          email: 'a@b.com',
          verificationToken: 'vtoken-server-fallback',
          publicKey: SERVER_PUBLIC_KEY,
          privateKey: SERVER_PRIVATE_KEY,
        },
  signToken: () => 'jwt-token',
  getAuthCookieConfig: (token: string) => ({
    name: 'auth_token',
    value: token,
    options: { httpOnly: true, path: '/' },
  }),
  getClearAuthCookieConfig: () => ({ name: 'auth_token', value: '', options: { maxAge: 0, path: '/' } }),
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

function verifyOtpRequest(body: Record<string, unknown>) {
  return new Request('http://x/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('verify-otp OTP_LOGIN response boundary', () => {
  test('a client-supplied publicKey gets back the token bound to it, and never a privateKey', async () => {
    const req = verifyOtpRequest({ sessionId: 's1', code: '123456', publicKey: CLIENT_PUBLIC_KEY });
    const res = await routes().verifyOtp(req, new URL(req.url), '203.0.113.10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.verified).toBe(true);
    expect(body.verificationToken).toBe('vtoken-client-bound');
    expect(body.publicKey).toBe(CLIENT_PUBLIC_KEY);
    expect(body.privateKey).toBeUndefined();
  });

  test('omitting publicKey (server-fallback path) reports cookie-auth only — no dead token, no leaked privateKey', async () => {
    const req = verifyOtpRequest({ sessionId: 's1', code: '123456' });
    const res = await routes().verifyOtp(req, new URL(req.url), '203.0.113.11');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.verified).toBe(true);
    expect(body.email).toBe('a@b.com');
    expect(body.subOrgId).toBe('sub-1');
    // The session cookie still authenticates the caller either way.
    expect(res.headers.get('set-cookie')).toBeTruthy();
    // But no OTP_LOGIN material the caller can't act on, and never the
    // server-generated privateKey itself.
    expect(body.verificationToken).toBeUndefined();
    expect(body.publicKey).toBeUndefined();
    expect(body.privateKey).toBeUndefined();
  });
});
