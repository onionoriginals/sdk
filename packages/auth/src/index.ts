/**
 * @originals/auth - Turnkey-based authentication for the Originals Protocol
 *
 * This package provides authentication utilities for both server and client applications.
 *
 * Server-side:
 * ```typescript
 * import { createAuthMiddleware, initiateEmailAuth, verifyEmailAuth } from '@originals/auth/server';
 * ```
 *
 * Client-side (pure functions, no React):
 * ```typescript
 * import { initializeTurnkeyClient, initOtp, completeOtp, fetchWallets } from '@originals/auth/client';
 * ```
 *
 * Types:
 * ```typescript
 * import type { AuthUser, TokenPayload, TurnkeyWallet } from '@originals/auth/types';
 * ```
 */

// Types only. The root MUST stay free of server code: re-exporting
// './server/index.js' here pulled jsonwebtoken, @turnkey/sdk-server and the
// Express middleware into any bundle that imported so much as a type from
// '@originals/auth' — contradicting the docstring above it (plan 045).
export * from './types.js';

// Isomorphic: byte-level Turnkey signing, safe in either environment.
export { turnkeySignBytes, type TurnkeySignBytesOptions } from './turnkey-sign-bytes.js';

// Server utilities: import from '@originals/auth/server'.
// Client utilities: import from '@originals/auth/client'.



