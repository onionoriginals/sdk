/**
 * Test doubles for consumer test suites — import from '@originals/sdk/testing'.
 * Deliberately NOT part of the root entry: production bundles should never
 * carry mock providers (plan 043).
 */
export { OrdMockProvider } from '../adapters/providers/OrdMockProvider.js';
export { FeeOracleMock } from '../adapters/FeeOracleMock.js';
