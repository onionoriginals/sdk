/**
 * The landing's session check for the @originals/host routes: the JWT from
 * the `auth_token` cookie or a Bearer header, verified with the deploy's
 * secret, names the caller's subOrgId. A missing token is null and a bad one
 * throws; createOriginalsRoutes answers 401 for both.
 */
import { verifyToken } from '@originals/auth/server';
import { extractToken, type Authenticate } from '@originals/host';

export function jwtAuthenticate(jwtSecret: string): Authenticate {
  return (req) => {
    const token = extractToken(req);
    if (!token) return null;
    return verifyToken(token, { secret: jwtSecret }).sub;
  };
}
