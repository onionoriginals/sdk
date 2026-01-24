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
} from './turnkey-client';

export { TurnkeyDIDSigner, createDIDWithTurnkey } from './turnkey-did-signer';

export { sendOtp, verifyOtp, type ServerAuthOptions } from './server-auth';
