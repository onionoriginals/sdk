import { describe, test, expect } from 'bun:test';
import {
  bootstrapFailureMessage,
  reportBootstrapFailure,
  prerequisiteFailure,
  signingFailureNotice,
  type BootstrapStep,
} from './bootstrap-report';
import { BoundKeyMismatchError } from './turnkey-session';
import { demo } from '../content';

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

describe('a missing prerequisite is attributed to the step that actually failed', () => {
  // The bug this exists to prevent: reporting a missing verificationToken as
  // 'open-session-key' sends an operator to IndexedDB/WebCrypto when the
  // browser key opened perfectly well and the OTP prerequisite is what broke.
  test('a key that opened + no token is an otp-login failure, not a key failure', () => {
    const failure = prerequisiteFailure({ sessionKey: true, verificationToken: false });
    expect(failure?.step).toBe('otp-login');
    expect(failure?.reason).toContain('verificationToken');
  });

  test('no browser key is a key failure, and takes precedence', () => {
    expect(prerequisiteFailure({ sessionKey: false, verificationToken: false })?.step).toBe(
      'open-session-key'
    );
    expect(prerequisiteFailure({ sessionKey: false, verificationToken: true })?.step).toBe(
      'open-session-key'
    );
  });

  test('both present is not a failure', () => {
    expect(prerequisiteFailure({ sessionKey: true, verificationToken: true })).toBeNull();
  });
});

/**
 * #494 — a token bound to a foreign key is refused, and the person whose
 * account it was aimed at must be told THAT, not the generic "signing is
 * unavailable" every other bootstrap failure shows. Nothing else gets a
 * user-facing reason: an outage is still on us, and the generic copy is right.
 */
describe('a refused foreign-key token reaches the user as its own notice', () => {
  test('the bound-key refusal maps to its own copy from content.ts', () => {
    const notice = signingFailureNotice(new BoundKeyMismatchError());
    expect(notice).toBe(demo.session.boundKeyMismatchBody);
    expect(notice).not.toContain('Error');
  });

  test('every other failure stays on the generic unavailable copy', () => {
    expect(signingFailureNotice(new Error('STAMP_LOGIN failed (503): no message'))).toBeNull();
    expect(signingFailureNotice('not even an error')).toBeNull();
    expect(signingFailureNotice(undefined)).toBeNull();
  });

  test('the copy says what happened, does not offer "sign in again", and says the money is safe', () => {
    const copy = demo.session.boundKeyMismatchBody.toLowerCase();
    expect(copy).toContain('key');
    expect(copy).toContain('this browser');
    expect(copy).not.toContain('sign in again');
    expect(copy).toMatch(/deposit|btc|bitcoin/);
  });
});
