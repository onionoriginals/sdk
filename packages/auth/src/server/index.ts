/**
 * Server-side authentication utilities
 *
 * @example
 * ```typescript
 * import {
 *   createAuthMiddleware,
 *   initiateEmailAuth,
 *   verifyEmailAuth,
 *   signToken,
 *   verifyToken,
 *   createTurnkeyClient,
 *   TurnkeyWebVHSigner
 * } from '@originals/auth/server';
 * ```
 */

export { createTurnkeyClient, getOrCreateTurnkeySubOrg, TurnkeyHttpClient } from './turnkey-client';
export {
  initiateEmailAuth,
  verifyEmailAuth,
  isSessionVerified,
  cleanupSession,
  getSession,
  type SessionStorage,
  createInMemorySessionStorage,
} from './email-auth';
export {
  signToken,
  verifyToken,
  getAuthCookieConfig,
  getClearAuthCookieConfig,
} from './jwt';
export { createAuthMiddleware } from './middleware';
export { TurnkeyWebVHSigner, createTurnkeySigner } from './turnkey-signer';







