import { describe, test, expect, beforeEach } from 'bun:test';
import { createInMemorySessionStorage, type SessionStorage } from '@originals/auth/server';
import { createAuthRoutes } from '../auth-routes';

const JWT_SECRET = 'test-secret-please-change-to-at-least-32ch';

// Turnkey mock: initOtp returns an id + a dummy target bundle; verifyOtp returns a token;
// sub-org lookup/create returns a stable id. Enough to drive the 2.0 flow without real Turnkey.
function mockTurnkey() {
  return {
    apiClient: () => ({
      initOtp: async () => ({ otpId: 'otp1', otpEncryptionTargetBundle: 'bundle1' }),
      getSubOrgIds: async () => ({ organizationIds: ['subABC'] }),
      getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
    }),
  } as any;
}

let sessions: SessionStorage;
beforeEach(() => {
  sessions = createInMemorySessionStorage();
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.TURNKEY_ORGANIZATION_ID = 'parentOrg';
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('auth-routes', () => {
  test('sendOtp rejects invalid email', async () => {
    const { sendOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const res = await sendOtp(post('/api/auth/send-otp', { email: 'nope' }), new URL('http://x/api/auth/send-otp'));
    expect(res.status).toBe(400);
  });

  test('sendOtp returns a sessionId and does NOT provision a sub-org', async () => {
    const { sendOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const res = await sendOtp(post('/api/auth/send-otp', { email: 'a@b.com' }), new URL('http://x/api/auth/send-otp'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    // Deferred provisioning: no subOrgId on the session yet.
    const session = sessions.get(body.sessionId);
    expect(session?.subOrgId).toBeUndefined();
  });

  test('sendOtp rate-limits repeated calls for same email', async () => {
    const { sendOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const url = new URL('http://x/api/auth/send-otp');
    // limit is 5/window in impl; 6th must 429
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await sendOtp(post('/api/auth/send-otp', { email: 'rl@b.com' }, { 'x-forwarded-for': '1.1.1.1' }), url);
    }
    expect(last!.status).toBe(429);
  });

  test('me returns 401 without a cookie', async () => {
    const { me } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const res = await me(new Request('http://x/api/me'), new URL('http://x/api/me'));
    expect(res.status).toBe(401);
  });

  test('me returns the payload for a valid token', async () => {
    const { signToken } = await import('@originals/auth/server');
    const token = signToken('subABC', 'a@b.com', undefined, { secret: JWT_SECRET });
    const { me } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const req = new Request('http://x/api/me', { headers: { Cookie: `auth_token=${token}` } });
    const res = await me(req, new URL('http://x/api/me'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subOrgId: 'subABC', email: 'a@b.com' });
  });

  test('logout clears the cookie', async () => {
    const { logout } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const res = await logout(post('/api/auth/logout', {}), new URL('http://x/api/auth/logout'));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('verifyOtp rejects malformed code before Turnkey', async () => {
    const { sendOtp, verifyOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const s = await (await sendOtp(post('/api/auth/send-otp', { email: 'v@b.com' }), new URL('http://x/api/auth/send-otp'))).json();
    const res = await verifyOtp(post('/api/auth/verify-otp', { sessionId: s.sessionId, code: 'abc' }), new URL('http://x/api/auth/verify-otp'));
    expect(res.status).toBe(400);
  });
});

// U7: the routes key on the client identity the server layer resolved (third
// handler argument), never on a header they read themselves.
describe('auth-routes client-identity keying', () => {
  const url = (p: string) => new URL(`http://x${p}`);

  test('send-otp buckets are per resolved client identity, not per header', async () => {
    const { sendOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    // Same client identity, a DIFFERENT spoofed header each time → one bucket.
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await sendOtp(
        post('/api/auth/send-otp', { email: `a${i}@b.com` }, { 'x-forwarded-for': `9.9.9.${i}` }),
        url('/api/auth/send-otp'),
        '203.0.113.7'
      );
    }
    expect(last!.status).toBe(429);
    // A different client identity is unaffected.
    const other = await sendOtp(
      post('/api/auth/send-otp', { email: 'z@b.com' }, { 'x-forwarded-for': '9.9.9.0' }),
      url('/api/auth/send-otp'),
      '203.0.113.8'
    );
    expect(other.status).toBe(200);
  });

  test('the per-email limit still applies independently of the per-client limit', async () => {
    const { sendOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    // Five different client identities, one shared email → the email bucket trips.
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await sendOtp(
        post('/api/auth/send-otp', { email: 'shared@b.com' }),
        url('/api/auth/send-otp'),
        `198.51.100.${i}`
      );
    }
    expect(last!.status).toBe(429);
  });

  test('verify-otp is rate limited per client identity', async () => {
    const { verifyOtp } = createAuthRoutes({ turnkey: mockTurnkey(), sessions, jwtSecret: JWT_SECRET });
    const attempt = (ip: string) =>
      verifyOtp(
        post('/api/auth/verify-otp', { sessionId: 'nope', code: '123456' }),
        url('/api/auth/verify-otp'),
        ip
      );
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) last = await attempt('203.0.113.7');
    expect(last!.status).toBe(429);
    expect(last!.headers.get('Retry-After')).toBeTruthy();
    // A different client still gets through.
    expect((await attempt('203.0.113.9')).status).not.toBe(429);
  });
});
