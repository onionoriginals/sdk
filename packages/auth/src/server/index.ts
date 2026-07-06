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

export { createTurnkeyClient, getOrCreateTurnkeySubOrg } from './turnkey-client.js';
export {
  initiateEmailAuth,
  verifyEmailAuth,
  isSessionVerified,
  cleanupSession,
  getSession,
  type SessionStorage,
  type VerifyEmailAuthOptions,
  createInMemorySessionStorage,
} from './email-auth.js';
export {
  encryptOtpCode,
  type EncryptOtpCodeParams,
  type EncryptOtpCodeResult,
} from '../otp-encryption.js';
export {
  signToken,
  verifyToken,
  getAuthCookieConfig,
  getClearAuthCookieConfig,
} from './jwt.js';
export { createAuthMiddleware } from './middleware.js';
export { TurnkeyWebVHSigner, createTurnkeySigner } from './turnkey-signer.js';







