import {
  initiateEmailAuth,
  verifyEmailAuth,
  signToken,
  verifyToken,
  getAuthCookieConfig,
  getClearAuthCookieConfig,
  type SessionStorage,
  type SubOrgLock,
} from '@originals/auth/server';
import type { Turnkey } from '@turnkey/sdk-server';
import { json, type Handler } from './router';
import { serializeCookie, extractToken } from './cookies';
import { createRateLimiter } from './rate-limit';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAuthRoutes(deps: {
  turnkey: Turnkey;
  sessions: SessionStorage;
  jwtSecret: string;
  // Serializes Turnkey sub-org lookup-then-create per email (#728). Optional
  // and defaults to @originals/auth's in-process lock, which is NOT safe
  // across multiple server instances: a multi-instance deploy must pass a
  // distributed SubOrgLock here, the same way it must pass a shared
  // `sessions` store instead of the in-memory default.
  subOrgLock?: SubOrgLock;
}): { sendOtp: Handler; verifyOtp: Handler; me: Handler; logout: Handler } {
  // Per-client and per-email limiters (README: throttle both). `clientIp` is
  // the identity the server layer resolved (client-ip.ts) — these routes never
  // read X-Forwarded-For themselves, which is how the limit used to be
  // bypassable by rotating it. Sending an OTP costs email reputation, so 5/min
  // per client stands; the per-email bucket is what bounds one address being
  // mailed from many clients.
  const clientLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
  const emailLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
  // Hardening, not a hole: five failed codes destroy the pending session and
  // minting one goes through the limiter above. 10/min leaves room for a
  // fat-fingered retry while capping the automated grind.
  const verifyLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

  const sendOtp: Handler = async (req, _url, clientIp) => {
    const { email } = (await req.json().catch(() => ({}))) as { email?: string };
    if (!email || !EMAIL_RE.test(email)) return json({ error: 'invalid_email', message: 'Invalid email format' }, 400);

    const normalized = email.trim().toLowerCase();
    const rl = clientLimiter.check(clientIp ?? 'local');
    const em = emailLimiter.check(normalized);
    if (!rl.allowed || !em.allowed) {
      const retryAfterMs = Math.max(rl.retryAfterMs, em.retryAfterMs);
      return json({ error: 'rate_limited', message: 'Too many requests. Please try again later.' }, 429, {
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
      });
    }

    try {
      const result = await initiateEmailAuth(normalized, deps.turnkey, deps.sessions);
      return json(result); // { sessionId, message }
    } catch (e) {
      console.error('[auth] send-otp failed:', e); // log cause; don't leak upstream errors to clients
      return json({ error: 'send_otp_failed', message: 'Failed to send verification code. Please try again.' }, 500);
    }
  };

  const verifyOtp: Handler = async (req, _url, clientIp) => {
    const rl = verifyLimiter.check(clientIp ?? 'local');
    if (!rl.allowed) {
      return json({ error: 'rate_limited', message: 'Too many requests. Please try again later.' }, 429, {
        'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
    }
    const { sessionId, code, publicKey } = (await req.json().catch(() => ({}))) as {
      sessionId?: string;
      code?: string;
      publicKey?: string;
    };
    if (!sessionId || !code) return json({ error: 'missing_fields', message: 'Session ID and code are required' }, 400);

    try {
      const result = await verifyEmailAuth(sessionId, code, deps.turnkey, deps.sessions, {
        publicKey,
        subOrgLock: deps.subOrgLock,
      });
      if (!result.verified || !result.subOrgId || !result.email) {
        return json({ error: 'verification_failed', message: 'Verification failed' }, 400);
      }
      const token = signToken(result.subOrgId, result.email, undefined, { secret: deps.jwtSecret });
      // `secure` is stated, not inferred (SEC-1). getAuthCookieConfig otherwise
      // derives it from NODE_ENV === 'production', and the platform this
      // deploys to does not set NODE_ENV — which silently drops Secure from the
      // 7-day JWT that gates every money route. This site is HTTPS-only
      // regardless of what an env var says, so it says so here.
      const cookie = serializeCookie(getAuthCookieConfig(token, { secure: true }));
      // Surface the Turnkey verificationToken + the P-256 pubkey it is bound to
      // so the browser can run OTP_LOGIN and install its own session credential
      // (Track B, testnet4 signing) — but only when THIS request supplied a
      // client-held publicKey. The token is then bound to a key the caller
      // already holds, so returning it is safe. When no client publicKey was
      // supplied, verifyEmailAuth falls back to a server-generated ephemeral
      // keypair and returns its privateKey instead of ours doing so (#708):
      // that private key must never transit this HTTP response, so a caller
      // on that path gets cookie-auth only, not a verificationToken/publicKey
      // it has no usable private key to complete OTP_LOGIN with. The httpOnly
      // session JWT cookie is UNCHANGED either way.
      const otpLogin = publicKey
        ? { verificationToken: result.verificationToken, publicKey: result.publicKey }
        : {};
      return json(
        {
          verified: true,
          email: result.email,
          subOrgId: result.subOrgId,
          ...otpLogin,
        },
        200,
        { 'Set-Cookie': cookie }
      );
    } catch (e) {
      console.error('[auth] verify-otp failed:', e); // log cause; generic message so Turnkey internals don't leak
      return json(
        { error: 'verification_failed', message: 'Verification failed. Please check the code or request a new one.' },
        400
      );
    }
  };

  const me: Handler = async (req) => {
    const token = extractToken(req);
    if (!token) return json({ error: 'unauthorized', message: 'Not authenticated' }, 401);
    try {
      const payload = verifyToken(token, { secret: deps.jwtSecret });
      return json({ subOrgId: payload.sub, email: payload.email });
    } catch {
      return json({ error: 'invalid_token', message: 'Invalid or expired token' }, 401);
    }
  };

  const logout: Handler = async () => {
    // Matches the set above: a clear that drops Secure would be sent over a
    // channel the original cookie never used.
    const cookie = serializeCookie(getClearAuthCookieConfig(undefined, { secure: true }));
    return json({ success: true }, 200, { 'Set-Cookie': cookie });
  };

  return { sendOtp, verifyOtp, me, logout };
}
