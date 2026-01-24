/**
 * Express authentication middleware factory
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './jwt';
import type { AuthMiddlewareOptions, AuthUser, AuthenticatedRequest } from '../types';

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
    try {
      // Get JWT token from HTTP-only cookie
      const cookies = req.cookies as Record<string, string> | undefined;
      const token = cookies?.[cookieName];

      if (!token) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Verify JWT token
      const payload = verifyToken(token, { secret: options.jwtSecret });
      const turnkeySubOrgId = payload.sub;
      const email = payload.email;

      // Check if user already exists
      let user: AuthUser | null = await options.getUserByTurnkeyId(turnkeySubOrgId);

      // If user doesn't exist and createUser is provided, create user
      if (!user && options.createUser) {
        console.log(`Creating user record for ${email}...`);

        // Use temporary DID as placeholder until user creates real DID
        const temporaryDid = `temp:turnkey:${turnkeySubOrgId}`;

        user = await options.createUser(turnkeySubOrgId, email, temporaryDid);

        console.log(`✅ User created: ${email}`);
        console.log(`   Turnkey sub-org ID: ${turnkeySubOrgId}`);
        console.log(`   Temporary DID: ${temporaryDid}`);
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
      console.error('Authentication error:', error);
      return res.status(401).json({ error: 'Invalid or expired token' });
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
    try {
      const cookies = req.cookies as Record<string, string> | undefined;
      const token = cookies?.[cookieName];

      if (!token) {
        next();
        return;
      }

      const payload = verifyToken(token, { secret: options.jwtSecret });
      const turnkeySubOrgId = payload.sub;
      const email = payload.email;

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
    } catch {
      // Token invalid or expired, continue without user
      next();
    }
  };
}







