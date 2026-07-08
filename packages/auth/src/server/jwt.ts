/**
 * JWT Authentication Module
 * Implements secure token issuance and validation with HTTP-only cookies
 */

import jwt from 'jsonwebtoken';
import type { TokenPayload, AuthCookieConfig } from '../types.js';

// 7 days in seconds
const DEFAULT_JWT_EXPIRES_IN = 7 * 24 * 60 * 60;

// HS256 keys shorter than the hash output (32 bytes) weaken the MAC and are
// trivially brute-forceable; RFC 7518 §3.2 requires >= 256 bits.
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Get JWT secret from config or environment
 */
function getJwtSecret(configSecret?: string): string {
  const secret = configSecret ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT secret must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
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
 * @throws Error if token is invalid or expired
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
      throw new Error('Token missing sub-organization ID');
    }

    return payload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Token has expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token');
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
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    name: options?.cookieName ?? 'auth_token',
    value: token,
    options: {
      httpOnly: true, // Cannot be accessed by JavaScript (XSS protection)
      secure: options?.secure ?? isProduction, // HTTPS only in production
      sameSite: 'strict', // CSRF protection
      maxAge: options?.maxAge ?? 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
      path: '/', // Available for all routes
    },
  };
}

/**
 * Get cookie configuration for logout (clears the auth cookie)
 * @param cookieName - Name of the cookie to clear
 * @returns Cookie configuration for clearing
 */
export function getClearAuthCookieConfig(cookieName?: string): AuthCookieConfig {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    name: cookieName ?? 'auth_token',
    value: '',
    options: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: 0, // Expire immediately
      path: '/',
    },
  };
}

