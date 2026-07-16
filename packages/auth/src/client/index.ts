/**
 * Client-side authentication utilities
 *
 * Pure library functions for Turnkey authentication.
 * No React dependencies - consuming apps should create their own hooks.
 *
 * @example
 * ```typescript
 * import {
 *   initializeTurnkeyClient,
 *   initOtp,
 *   completeOtp,
 *   fetchUser,
 *   fetchWallets,
 *   TurnkeyDIDSigner,
 *   createDIDWithTurnkey
 * } from '@originals/auth/client';
 * ```
 */

export {
  initializeTurnkeyClient,
  initOtp,
  completeOtp,
  fetchUser,
  fetchWallets,
  getKeyByCurve,
  createWalletWithAccounts,
  ensureWalletWithAccounts,
  TurnkeySessionExpiredError,
  withTokenExpiration,
  type InitOtpResult,
  type CompleteOtpOptions,
  type CompleteOtpResult,
} from './turnkey-client.js';

export {
  encryptOtpCode,
  type EncryptOtpCodeParams,
  type EncryptOtpCodeResult,
} from '../otp-encryption.js';

export { TurnkeyDIDSigner, createDIDWithTurnkey } from './turnkey-did-signer.js';

export {
  sendOtp,
  verifyOtp,
  type ServerAuthOptions,
  type VerifyOtpClientOptions,
} from './server-auth.js';
