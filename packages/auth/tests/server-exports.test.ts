import { describe, test, expect } from 'bun:test';
import * as serverEntry from '../src/server/index';

// Regression for #730: createOptionalAuthMiddleware was implemented and
// documented (this file's own module doc comment lists it), but never
// re-exported from the package's public `@originals/auth/server` entry
// point, so `import { createOptionalAuthMiddleware } from '@originals/auth/server'`
// resolved to `undefined` at runtime despite the function existing.
describe('@originals/auth/server public exports', () => {
  test('createAuthMiddleware is reachable from the public entry point', () => {
    expect(typeof serverEntry.createAuthMiddleware).toBe('function');
  });

  test('createOptionalAuthMiddleware is reachable from the public entry point', () => {
    expect(typeof serverEntry.createOptionalAuthMiddleware).toBe('function');
  });

  test('exports the typed JWT error helpers used to classify middleware failures (#729, #747)', () => {
    expect(typeof serverEntry.isAuthTokenCredentialError).toBe('function');
    expect(serverEntry.AUTH_JWT_ERROR_CODES.tokenInvalid).toBe('AUTH_TOKEN_INVALID');
    expect(serverEntry.AUTH_JWT_ERROR_CODES.tokenExpired).toBe('AUTH_TOKEN_EXPIRED');
    expect(serverEntry.AUTH_JWT_ERROR_CODES.tokenMissingSubject).toBe('AUTH_TOKEN_MISSING_SUBJECT');
    expect(serverEntry.AUTH_JWT_ERROR_CODES.configMissingSecret).toBe('AUTH_JWT_CONFIG_SECRET_MISSING');
    expect(serverEntry.AUTH_JWT_ERROR_CODES.configWeakSecret).toBe('AUTH_JWT_CONFIG_SECRET_WEAK');
  });
});
