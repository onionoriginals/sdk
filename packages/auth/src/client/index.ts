/**
 * Client-side authentication utilities
 *
 * @example
 * ```typescript
 * import {
 *   useAuth,
 *   useTurnkeyAuth,
 *   initializeTurnkeyClient,
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
} from './turnkey-client';

export { TurnkeyDIDSigner, createDIDWithTurnkey } from './turnkey-did-signer';

export { useAuth } from './hooks/useAuth';
export { useTurnkeyAuth } from './hooks/useTurnkeyAuth';



