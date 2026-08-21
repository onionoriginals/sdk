import { describe, test, expect } from 'bun:test';
import {
  bootstrapFailureMessage,
  reportBootstrapFailure,
  type BootstrapStep,
} from './bootstrap-report';

const STEPS: BootstrapStep[] = ['open-session-key', 'otp-login', 'funding-account'];

describe('the signing bootstrap says which step failed', () => {
  test('every step produces a distinct, machine-greppable line', () => {
    const lines = STEPS.map((s) => bootstrapFailureMessage('sign-in', s));
    expect(new Set(lines).size).toBe(STEPS.length);
    for (const step of STEPS) {
      expect(bootstrapFailureMessage('sign-in', step)).toContain(`[step=${step}]`);
    }
  });

  test('the origin is named, so a reload failure is not read as a sign-in failure', () => {
    expect(bootstrapFailureMessage('reload', 'otp-login')).toContain('reload');
    expect(bootstrapFailureMessage('sign-in', 'otp-login')).toContain('sign-in');
  });

  // The whole point of the change: console.warn is dropped by the default
  // "Errors" filter, which is the filter in use when someone is debugging.
  test('reports at error level, not warn, and passes the error through intact', () => {
    const seen: unknown[][] = [];
    const cause = new Error('Turnkey said no');
    reportBootstrapFailure('sign-in', 'otp-login', cause, {
      error: (...args: unknown[]) => seen.push(args),
    } as unknown as Pick<Console, 'error'>);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toContain('[step=otp-login]');
    // Unflattened — an operator can expand it and read Turnkey's own fields.
    expect(seen[0][1]).toBe(cause);
  });
});
