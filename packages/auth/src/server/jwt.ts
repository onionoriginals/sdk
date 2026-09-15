/**
 * JWT Authentication Module
 * Implements secure token issuance and validation with HTTP-only cookies
 */

import jwt from 'jsonwebtoken';
import { StructuredError } from '@originals/sdk';
import type { TokenPayload, AuthCookieConfig } from '../types.js';

// 7 days in seconds
const DEFAULT_JWT_EXPIRES_IN = 7 * 24 * 60 * 60;

// HS256 keys shorter than the hash output (32 bytes) weaken the MAC and are
// trivially brute-forceable; RFC 7518 §3.2 requires >= 256 bits.
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Stable error codes for `signToken`/`verifyToken` failures.
 *
 * The `AUTH_JWT_CONFIG_*` codes mean the deployment is misconfigured (missing
 * or weak secret) — never evidence about the caller's credentials. The
 * `AUTH_TOKEN_*` codes mean the presented token itself is bad. Callers (e.g.
 * `createAuthMiddleware`) rely on this split to avoid reporting a server
 * configuration failure as a 401 (#729, #747).
 */
export const AUTH_JWT_ERROR_CODES = {
  configMissingSecret: 'AUTH_JWT_CONFIG_SECRET_MISSING',
  configWeakSecret: 'AUTH_JWT_CONFIG_SECRET_WEAK',
  tokenInvalid: 'AUTH_TOKEN_INVALID',
  tokenExpired: 'AUTH_TOKEN_EXPIRED',
  tokenMissingSubject: 'AUTH_TOKEN_MISSING_SUBJECT',
} as const;

/** Error codes that mean "the token itself is bad" rather than a config/operational failure. */
export const AUTH_TOKEN_CREDENTIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  AUTH_JWT_ERROR_CODES.tokenInvalid,
  AUTH_JWT_ERROR_CODES.tokenExpired,
  AUTH_JWT_ERROR_CODES.tokenMissingSubject,
]);

/** True if `error` is a `StructuredError` reporting a bad token/credential, not a config/operational failure. */
export function isAuthTokenCredentialError(error: unknown): error is StructuredError {
  return error instanceof StructuredError && AUTH_TOKEN_CREDENTIAL_ERROR_CODES.has(error.code);
}

/**
 * Get JWT secret from config or environment
 */
function getJwtSecret(configSecret?: string): string {
  const secret = configSecret ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new StructuredError(
      AUTH_JWT_ERROR_CODES.configMissingSecret,
      'JWT_SECRET environment variable is required'
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new StructuredError(
      AUTH_JWT_ERROR_CODES.configWeakSecret,
      `JWT secret must be at least ${MIN_JWT_SECRET_LENGTH} characters`
    );
  }
  return secret;
}

/**
 * Sign a JWT token for a user
 * @param subOrgId - Turnkey sub-organization ID (stable identifier)
 * @param email - User email (metadata)
 * @param sessionToken - Optional Turnkey session token for user authentication
 * @param options - Additional options
 * @returns Signed JWT token string
 */
export function signToken(
  subOrgId: string,
  email: string,
  sessionToken?: string,
  options?: {
    secret?: string;
    expiresIn?: number;
    issuer?: string;
    audience?: string;
  }
): string {
  if (!subOrgId) {
    throw new Error('Sub-organization ID is required for token signing');
  }

  const secret = getJwtSecret(options?.secret);

  const payload: Record<string, unknown> = {
    sub: subOrgId,
    email,
  };

  if (sessionToken) {
    payload.sessionToken = sessionToken;
  }

  const signOptions: jwt.SignOptions = {
    expiresIn: options?.expiresIn ?? DEFAULT_JWT_EXPIRES_IN,
    issuer: options?.issuer ?? 'originals-auth',
    audience: options?.audience ?? 'originals-api',
  };

  return jwt.sign(payload, secret, signOptions);
}

/**
 * Verify and decode a JWT token
 * @param token - JWT token string
 * @param options - Additional options
 * @returns Decoded token payload
 * @throws {StructuredError} `AUTH_TOKEN_EXPIRED`/`AUTH_TOKEN_INVALID`/`AUTH_TOKEN_MISSING_SUBJECT`
 *   for a bad token, or `AUTH_JWT_CONFIG_SECRET_MISSING`/`AUTH_JWT_CONFIG_SECRET_WEAK` for a
 *   misconfigured server secret — see {@link isAuthTokenCredentialError} to distinguish them.
 */
export function verifyToken(
  token: string,
  options?: {
    secret?: string;
    issuer?: string;
    audience?: string;
  }
): TokenPayload {
  const secret = getJwtSecret(options?.secret);

  try {
    const payload = jwt.verify(token, secret, {
      issuer: options?.issuer ?? 'originals-auth',
      audience: options?.audience ?? 'originals-api',
      // Pin the algorithm family: signing uses HS256 (jsonwebtoken's default
      // for string secrets), and leaving verify unpinned invites algorithm
      // confusion/downgrade if the library or key handling ever changes
      // (issue #352).
      algorithms: ['HS256'],
    }) as TokenPayload;

    if (!payload.sub) {
      throw new StructuredError(
        AUTH_JWT_ERROR_CODES.tokenMissingSubject,
        'Token missing sub-organization ID'
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new StructuredError(AUTH_JWT_ERROR_CODES.tokenExpired, 'Token has expired', {
        cause: error,
      });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new StructuredError(AUTH_JWT_ERROR_CODES.tokenInvalid, 'Invalid token', {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Generate a secure cookie configuration for authentication tokens
 * @param token - JWT token to set in cookie
 * @param options - Cookie options
 * @returns Cookie configuration object
 */
export function getAuthCookieConfig(
  token: string,
  options?: {
    cookieName?: string;
    maxAge?: number;
    secure?: boolean;
  }
): AuthCookieConfig {
  return {
    name: options?.cookieName ?? 'auth_token',
    value: token,
    options: {
      httpOnly: true, // Cannot be accessed by JavaScript (XSS protection)
      // Secure by default: not every deployment platform sets
      // NODE_ENV=production verbatim, so inferring `secure` from it silently
      // ships the 7-day auth cookie without Secure. Pass `{ secure: false }`
      // explicitly for local plain-HTTP development (issue #676).
      secure: options?.secure ?? true,
      sameSite: 'strict', // CSRF protection
      maxAge: options?.maxAge ?? 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
      path: '/', // Available for all routes
    },
  };
}

/**
 * Get cookie configuration for logout (clears the auth cookie)
 *
 * `secure` mirrors getAuthCookieConfig: a clear that drops the flag would be
 * sent — and could be intercepted — over a channel the original never used, so
 * a deployment that pins `secure: true` on the set must pin it here too.
 * @param cookieName - Name of the cookie to clear
 * @param options - Cookie options; `secure` defaults to `true` — pass
 * `{ secure: false }` explicitly for local plain-HTTP development.
 * @returns Cookie configuration for clearing
 */
export function getClearAuthCookieConfig(
  cookieName?: string,
  options?: { secure?: boolean }
): AuthCookieConfig {
  return {
    name: cookieName ?? 'auth_token',
    value: '',
    options: {
      httpOnly: true,
      secure: options?.secure ?? true,
      sameSite: 'strict',
      maxAge: 0, // Expire immediately
      path: '/',
    },
  };
}

