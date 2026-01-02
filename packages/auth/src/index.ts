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
 * Client-side:
 * ```typescript
 * import { useAuth, useTurnkeyAuth } from '@originals/auth/client';
 * ```
 *
 * Types:
 * ```typescript
 * import type { AuthUser, TokenPayload } from '@originals/auth/types';
 * ```
 */

// Re-export types
export * from './types';

// Re-export server utilities (for convenience, though subpath is preferred)
export * from './server';

// Note: Client utilities should be imported from '@originals/auth/client'
// to avoid bundling React in server environments



