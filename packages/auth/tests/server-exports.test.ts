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
});
