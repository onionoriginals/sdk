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

export {
  createTurnkeyClient,
  getOrCreateTurnkeySubOrg,
  normalizeEmail,
  createInProcessSubOrgLock,
  AUTH_TURNKEY_CLIENT_ERROR_CODES,
  type SubOrgLock,
} from './turnkey-client.js';
export {
  initiateEmailAuth,
  verifyEmailAuth,
  isSessionVerified,
  cleanupSession,
  getSession,
  AUTH_EMAIL_ERROR_CODES,
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
export {
  TurnkeyWebVHSigner,
  createTurnkeySigner,
  AUTH_TURNKEY_SIGNER_ERROR_CODES,
} from './turnkey-signer.js';







