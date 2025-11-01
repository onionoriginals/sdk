/**
 * JWT Authentication Module for Turnkey Integration
 * Implements secure token issuance and validation with HTTP-only cookies
 *
 * Critical PR #102 Feedback Addressed:
 * - Proper JWT format (not simplified tokens)
 * - Secure HTTP-only cookie storage (no localStorage)
 * - Token validation server-side
 */

import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: string; // Turnkey sub-organization ID (NOT email!)
  email: string; // User email (metadata only)
  sessionToken?: string; // Optional Turnkey session token for user authentication
  iat: number; // Issued at
  exp: number; // Expiration time
}

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  throw new Error('JWT_SECRET environment variable is required');
})();

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Sign a JWT token for a user
 * @param subOrgId - Turnkey sub-organization ID (stable identifier)
 * @param email - User email (metadata)
 * @param sessionToken - Optional Turnkey session token for user authentication
 * @returns Signed JWT token string
 */
export function signToken(subOrgId: string, email: string, sessionToken?: string): string {
  if (!subOrgId) {
    throw new Error('Sub-organization ID is required for token signing');
  }

  const payload: any = {
    sub: subOrgId, // Primary identifier
    email, // Metadata
  };

  // Include session token if provided
  if (sessionToken) {
    payload.sessionToken = sessionToken;
  }

  return jwt.sign(
    payload,
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
      issuer: 'originals-explorer',
      audience: 'originals-api',
    }
  );
}

/**
 * Verify and decode a JWT token
 * @param token - JWT token string
 * @returns Decoded token payload
 * @throws Error if token is invalid or expired
 */
export function verifyToken(token: string): TokenPayload {
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      issuer: 'originals-explorer',
      audience: 'originals-api',
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
 * @returns Cookie configuration object
 */
export function getAuthCookieConfig(token: string) {
  return {
    name: 'auth_token',
    value: token,
    options: {
      httpOnly: true, // Cannot be accessed by JavaScript (XSS protection)
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      sameSite: 'strict' as const, // CSRF protection
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
      path: '/', // Available for all routes
    },
  };
}

/**
 * Get cookie configuration for logout (clears the auth cookie)
 */
export function getClearAuthCookieConfig() {
  return {
    name: 'auth_token',
    value: '',
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict' as const,
      maxAge: 0, // Expire immediately
      path: '/',
    },
  };
}
