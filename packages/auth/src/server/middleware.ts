/**
 * Express authentication middleware factory
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyToken, isAuthTokenCredentialError } from './jwt.js';
import type { AuthMiddlewareOptions, AuthUser, AuthenticatedRequest } from '../types.js';

/**
 * Create an authentication middleware for Express
 *
 * @example
 * ```typescript
 * import { createAuthMiddleware } from '@originals/auth/server';
 *
 * const authenticateUser = createAuthMiddleware({
 *   getUserByTurnkeyId: async (turnkeyId) => {
 *     return db.query.users.findFirst({
 *       where: eq(users.turnkeySubOrgId, turnkeyId)
 *     });
 *   },
 *   createUser: async (turnkeyId, email, temporaryDid) => {
 *     return db.insert(users).values({
 *       turnkeySubOrgId: turnkeyId,
 *       email,
 *       did: temporaryDid,
 *     }).returning().then(rows => rows[0]);
 *   }
 * });
 *
 * app.get('/api/protected', authenticateUser, (req, res) => {
 *   res.json({ user: req.user });
 * });
 * ```
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => Promise<void | Response> {
  const cookieName = options.cookieName ?? 'auth_token';

  return async (req: Request, res: Response, next: NextFunction): Promise<void | Response> => {
    // Get JWT token from HTTP-only cookie
    const cookies = req.cookies as Record<string, string> | undefined;
    const token = cookies?.[cookieName];

    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Verify JWT token in its own try/catch, isolated from the
    // getUserByTurnkeyId/createUser calls below: classifying an error as a
    // bad credential must depend on where it came from (verifyToken), never
    // just on its `code` — a caller-supplied callback could reject with a
    // StructuredError whose code happens to collide with one of the
    // AUTH_TOKEN_* codes, and that must still be treated as an operational
    // failure, not fabricated into a 401 (#729, #747).
    let payload: ReturnType<typeof verifyToken>;
    try {
      payload = verifyToken(token, { secret: options.jwtSecret });
    } catch (error) {
      if (isAuthTokenCredentialError(error)) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      console.error('Authentication error:', error);
      return next(error);
    }

    const turnkeySubOrgId = payload.sub;
    const email = payload.email;

    try {
      // Check if user already exists
      let user: AuthUser | null = await options.getUserByTurnkeyId(turnkeySubOrgId);

      // If user doesn't exist and createUser is provided, create user.
      // Deliberately not logging here: emails and sub-org IDs are user PII
      // and must not go through raw console output.
      if (!user && options.createUser) {
        // Use temporary DID as placeholder until user creates real DID
        const temporaryDid = `temp:turnkey:${turnkeySubOrgId}`;

        user = await options.createUser(turnkeySubOrgId, email, temporaryDid);
      }

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // Add user info to request
      (req as Request & AuthenticatedRequest).user = {
        id: user.id,
        turnkeySubOrgId,
        email,
        did: user.did,
        sessionToken: payload.sessionToken,
      };

      next();
    } catch (error) {
      // A rejection from a caller-supplied callback is always an
      // operational failure at this point (the token itself already
      // verified above), so it always reaches Express's error handling.
      console.error('Authentication error:', error);
      return next(error);
    }
  };
}

/**
 * Optional authentication middleware - doesn't fail if not authenticated
 * Attaches user to request if valid token exists, otherwise continues without user
 */
export function createOptionalAuthMiddleware(
  options: AuthMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const cookieName = options.cookieName ?? 'auth_token';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const cookies = req.cookies as Record<string, string> | undefined;
    const token = cookies?.[cookieName];

    if (!token) {
      next();
      return;
    }

    // Verify in its own try/catch so classification depends on where the
    // error came from (verifyToken), never just its `code` — see the
    // matching comment in createAuthMiddleware (#729, #747).
    let payload: ReturnType<typeof verifyToken>;
    try {
      payload = verifyToken(token, { secret: options.jwtSecret });
    } catch (error) {
      if (isAuthTokenCredentialError(error)) {
        // Token invalid or expired: continue anonymously.
        next();
        return;
      }
      // A misconfigured JWT secret is an operational failure, not an
      // absent/bad credential — propagate it rather than silently treating
      // the caller as an anonymous guest.
      next(error);
      return;
    }

    const turnkeySubOrgId = payload.sub;
    const email = payload.email;

    try {
      const user = await options.getUserByTurnkeyId(turnkeySubOrgId);

      if (user) {
        (req as Request & AuthenticatedRequest).user = {
          id: user.id,
          turnkeySubOrgId,
          email,
          did: user.did,
          sessionToken: payload.sessionToken,
        };
      }

      next();
    } catch (error) {
      // The token already verified above, so a callback rejection here is
      // always an operational failure — propagate it rather than silently
      // treating the caller as an anonymous guest.
      next(error);
    }
  };
}







