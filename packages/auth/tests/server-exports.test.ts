import { describe, test, expect } from 'bun:test';
import * as serverIndex from '../src/server/index';

// Regression for #730: createOptionalAuthMiddleware was implemented and
// documented but never re-exported from the package's public `./server`
// entry point, so `import { createOptionalAuthMiddleware } from
// '@originals/auth/server'` failed even though the module existed.
describe('@originals/auth/server public surface', () => {
  test('exports createAuthMiddleware and createOptionalAuthMiddleware', () => {
    expect(typeof serverIndex.createAuthMiddleware).toBe('function');
    expect(typeof serverIndex.createOptionalAuthMiddleware).toBe('function');
  });

  test('exports the typed JWT error helpers used to classify middleware failures (#729, #747)', () => {
    expect(typeof serverIndex.isAuthTokenCredentialError).toBe('function');
    expect(serverIndex.AUTH_JWT_ERROR_CODES.tokenInvalid).toBe('AUTH_TOKEN_INVALID');
    expect(serverIndex.AUTH_JWT_ERROR_CODES.tokenExpired).toBe('AUTH_TOKEN_EXPIRED');
    expect(serverIndex.AUTH_JWT_ERROR_CODES.tokenMissingSubject).toBe('AUTH_TOKEN_MISSING_SUBJECT');
    expect(serverIndex.AUTH_JWT_ERROR_CODES.configMissingSecret).toBe('AUTH_JWT_CONFIG_SECRET_MISSING');
    expect(serverIndex.AUTH_JWT_ERROR_CODES.configWeakSecret).toBe('AUTH_JWT_CONFIG_SECRET_WEAK');
  });
});
