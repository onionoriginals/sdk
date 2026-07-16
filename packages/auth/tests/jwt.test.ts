import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { signToken, verifyToken, getAuthCookieConfig, getClearAuthCookieConfig } from '../src/server/jwt';

const TEST_SECRET = 'test-jwt-secret-that-is-long-enough-for-hs256';

describe('jwt', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.JWT_SECRET = originalEnv.JWT_SECRET;
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  });

  describe('signToken', () => {
    test('signs a token with subOrgId and email', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    test('includes sessionToken when provided', () => {
      const token = signToken('sub_org_123', 'user@example.com', 'session_token_abc', {
        secret: TEST_SECRET,
      });
      const payload = verifyToken(token, { secret: TEST_SECRET });
      expect(payload.sessionToken).toBe('session_token_abc');
    });

    test('omits sessionToken when not provided', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const payload = verifyToken(token, { secret: TEST_SECRET });
      expect(payload.sessionToken).toBeUndefined();
    });

    test('throws when subOrgId is empty', () => {
      expect(() => signToken('', 'user@example.com', undefined, { secret: TEST_SECRET })).toThrow(
        'Sub-organization ID is required'
      );
    });

    test('throws when no secret configured', () => {
      expect(() => signToken('sub_org_123', 'user@example.com')).toThrow(
        'JWT_SECRET environment variable is required'
      );
    });

    test('uses JWT_SECRET env var when no config secret', () => {
      process.env.JWT_SECRET = TEST_SECRET;
      const token = signToken('sub_org_123', 'user@example.com');
      expect(typeof token).toBe('string');
    });

    test('respects custom expiresIn', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
        expiresIn: 60, // 1 minute
      });
      const payload = verifyToken(token, { secret: TEST_SECRET });
      expect(payload.exp - payload.iat).toBe(60);
    });

    test('respects custom issuer and audience', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
        issuer: 'custom-issuer',
        audience: 'custom-audience',
      });
      // Should verify with matching issuer/audience
      const payload = verifyToken(token, {
        secret: TEST_SECRET,
        issuer: 'custom-issuer',
        audience: 'custom-audience',
      });
      expect(payload.sub).toBe('sub_org_123');
    });
  });

  describe('verifyToken', () => {
    test('verifies a valid token', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const payload = verifyToken(token, { secret: TEST_SECRET });
      expect(payload.sub).toBe('sub_org_123');
      expect(payload.email).toBe('user@example.com');
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
    });

    test('throws for expired token', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
        expiresIn: -1, // Already expired
      });
      expect(() => verifyToken(token, { secret: TEST_SECRET })).toThrow('Token has expired');
    });

    test('throws for invalid token', () => {
      expect(() => verifyToken('invalid.token.here', { secret: TEST_SECRET })).toThrow(
        'Invalid token'
      );
    });

    test('throws for token with wrong secret', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      expect(() => verifyToken(token, { secret: 'wrong-secret-that-is-long-enough-for-hs256' })).toThrow('Invalid token');
    });

    test('throws for token with wrong issuer', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
        issuer: 'issuer-a',
      });
      expect(() =>
        verifyToken(token, { secret: TEST_SECRET, issuer: 'issuer-b' })
      ).toThrow('Invalid token');
    });

    test('throws for token with wrong audience', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
        audience: 'audience-a',
      });
      expect(() =>
        verifyToken(token, { secret: TEST_SECRET, audience: 'audience-b' })
      ).toThrow('Invalid token');
    });

    test('throws when no secret configured', () => {
      expect(() => verifyToken('some.token.here')).toThrow(
        'JWT_SECRET environment variable is required'
      );
    });

    test('uses default issuer and audience', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      // Default verify should work with default sign
      const payload = verifyToken(token, { secret: TEST_SECRET });
      expect(payload.sub).toBe('sub_org_123');
    });
  });

  describe('security hardening (#352)', () => {
    test('full sign → verify round trip preserves the payload end-to-end', () => {
      // A dedicated end-to-end assertion: sign a token, then verify the exact
      // same string and confirm every claim survives the round trip.
      const token = signToken('sub_org_e2e', 'roundtrip@example.com', 'session_e2e', {
        secret: TEST_SECRET,
      });
      const payload = verifyToken(token, { secret: TEST_SECRET });
      expect(payload.sub).toBe('sub_org_e2e');
      expect(payload.email).toBe('roundtrip@example.com');
      expect(payload.sessionToken).toBe('session_e2e');
      expect(payload.iss).toBe('originals-auth');
      expect(payload.aud).toBe('originals-api');
      expect(typeof payload.iat).toBe('number');
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    test('verifyToken rejects an unsigned alg:none token', () => {
      // Algorithm-confusion guard: a token forged with `"alg":"none"` (no
      // signature) must be rejected because verify pins the HS256 family.
      const b64url = (obj: object) =>
        Buffer.from(JSON.stringify(obj)).toString('base64url');
      const header = b64url({ alg: 'none', typ: 'JWT' });
      const now = Math.floor(Date.now() / 1000);
      const body = b64url({
        sub: 'sub_org_123',
        email: 'attacker@example.com',
        iss: 'originals-auth',
        aud: 'originals-api',
        iat: now,
        exp: now + 3600,
      });
      // alg:none tokens carry an empty signature segment.
      const forged = `${header}.${body}.`;
      expect(() => verifyToken(forged, { secret: TEST_SECRET })).toThrow('Invalid token');
    });

    test('signToken rejects a secret shorter than 32 characters', () => {
      expect(() =>
        signToken('sub_org_123', 'user@example.com', undefined, { secret: 'short-secret' })
      ).toThrow('JWT secret must be at least 32 characters');
    });

    test('verifyToken rejects a secret shorter than 32 characters', () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      expect(() => verifyToken(token, { secret: 'short-secret' })).toThrow(
        'JWT secret must be at least 32 characters'
      );
    });

    test('rejects a short JWT_SECRET sourced from the environment', () => {
      process.env.JWT_SECRET = 'too-short';
      expect(() => signToken('sub_org_123', 'user@example.com')).toThrow(
        'JWT secret must be at least 32 characters'
      );
    });

    test('accepts a secret of exactly 32 characters', () => {
      const exactly32 = 'a'.repeat(32);
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: exactly32,
      });
      const payload = verifyToken(token, { secret: exactly32 });
      expect(payload.sub).toBe('sub_org_123');
    });
  });

  describe('getAuthCookieConfig', () => {
    test('returns correct cookie config with defaults', () => {
      const config = getAuthCookieConfig('jwt_token_here');
      expect(config.name).toBe('auth_token');
      expect(config.value).toBe('jwt_token_here');
      expect(config.options.httpOnly).toBe(true);
      expect(config.options.sameSite).toBe('strict');
      expect(config.options.path).toBe('/');
      expect(config.options.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
    });

    test('secure is false in non-production', () => {
      process.env.NODE_ENV = 'development';
      const config = getAuthCookieConfig('token');
      expect(config.options.secure).toBe(false);
    });

    test('secure is true in production', () => {
      process.env.NODE_ENV = 'production';
      const config = getAuthCookieConfig('token');
      expect(config.options.secure).toBe(true);
    });

    test('respects custom cookie name', () => {
      const config = getAuthCookieConfig('token', { cookieName: 'my_auth' });
      expect(config.name).toBe('my_auth');
    });

    test('respects custom maxAge', () => {
      const config = getAuthCookieConfig('token', { maxAge: 3600000 });
      expect(config.options.maxAge).toBe(3600000);
    });

    test('respects explicit secure override', () => {
      process.env.NODE_ENV = 'development';
      const config = getAuthCookieConfig('token', { secure: true });
      expect(config.options.secure).toBe(true);
    });
  });

  describe('getClearAuthCookieConfig', () => {
    test('returns config that clears the cookie', () => {
      const config = getClearAuthCookieConfig();
      expect(config.name).toBe('auth_token');
      expect(config.value).toBe('');
      expect(config.options.maxAge).toBe(0);
      expect(config.options.httpOnly).toBe(true);
      expect(config.options.sameSite).toBe('strict');
      expect(config.options.path).toBe('/');
    });

    test('respects custom cookie name', () => {
      const config = getClearAuthCookieConfig('my_auth');
      expect(config.name).toBe('my_auth');
    });

    test('secure matches environment', () => {
      process.env.NODE_ENV = 'production';
      const config = getClearAuthCookieConfig();
      expect(config.options.secure).toBe(true);
    });
  });
});
