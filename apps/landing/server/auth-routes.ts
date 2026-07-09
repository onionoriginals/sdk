import {
  initiateEmailAuth,
  verifyEmailAuth,
  signToken,
  verifyToken,
  getAuthCookieConfig,
  getClearAuthCookieConfig,
  type SessionStorage,
} from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, type Handler } from './router';
import { serializeCookie, extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
}

export function createAuthRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
}): { sendOtp: Handler; verifyOtp: Handler; me: Handler; logout: Handler } {
  // Per-IP and per-email limiters (README: throttle both).
  const ipLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
  const emailLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });

  const sendOtp: Handler = async (req) => {
    const { email } = (await req.json().catch(() => ({}))) as { email?: string };
    if (!email || !EMAIL_RE.test(email)) return json({ message: 'Invalid email format' }, 400);

    const normalized = email.trim().toLowerCase();
    const ip = ipLimiter.check(clientIp(req));
    const em = emailLimiter.check(normalized);
    if (!ip.allowed || !em.allowed) {
      const retryAfterMs = Math.max(ip.retryAfterMs, em.retryAfterMs);
      return json({ message: 'Too many requests. Please try again later.' }, 429, {
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
      });
    }

    try {
      const result = await initiateEmailAuth(normalized, deps.turnkey, deps.sessions);
      return json(result); // { sessionId, message }
    } catch (e) {
      console.error('[auth] send-otp failed:', e); // log cause; don't leak upstream errors to clients
      return json({ message: 'Failed to send verification code. Please try again.' }, 500);
    }
  };

  const verifyOtp: Handler = async (req) => {
    const { sessionId, code, publicKey } = (await req.json().catch(() => ({}))) as {
      sessionId?: string;
      code?: string;
      publicKey?: string;
    };
    if (!sessionId || !code) return json({ message: 'Session ID and code are required' }, 400);

    try {
      const result = await verifyEmailAuth(sessionId, code, deps.turnkey, deps.sessions, { publicKey });
      if (!result.verified || !result.subOrgId || !result.email) {
        return json({ message: 'Verification failed' }, 400);
      }
      const token = signToken(result.subOrgId, result.email, undefined, { secret: deps.jwtSecret });
      const cookie = serializeCookie(getAuthCookieConfig(token));
      return json(
        { verified: true, email: result.email, subOrgId: result.subOrgId },
        200,
        { 'Set-Cookie': cookie }
      );
    } catch (e) {
      console.error('[auth] verify-otp failed:', e); // log cause; generic message so Turnkey internals don't leak
      return json({ message: 'Verification failed. Please check the code or request a new one.' }, 400);
    }
  };

  const me: Handler = async (req) => {
    const token = extractToken(req);
    if (!token) return json({ message: 'Not authenticated' }, 401);
    try {
      const payload = verifyToken(token, { secret: deps.jwtSecret });
      return json({ subOrgId: payload.sub, email: payload.email });
    } catch {
      return json({ message: 'Invalid or expired token' }, 401);
    }
  };

  const logout: Handler = async () => {
    const cookie = serializeCookie(getClearAuthCookieConfig());
    return json({ success: true }, 200, { 'Set-Cookie': cookie });
  };

  return { sendOtp, verifyOtp, me, logout };
}
