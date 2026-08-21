/**
 * Why the signing bootstrap failed, reported so an operator can act on it.
 *
 * Three unrelated subsystems fail into one catch — the browser's IndexedDB
 * key, Turnkey's OTP_LOGIN, and the Bitcoin funding account — and the user
 * sees the same sentence for all three. That is right for the user and useless
 * for whoever has to fix it, so the log names the step.
 *
 * Reported at ERROR level on purpose. `console.warn` is hidden by the default
 * "Errors" console filter, which is exactly the filter someone uses when they
 * are looking at a broken page: the one line that explains the failure is the
 * one line they cannot see.
 */

/** Where the bootstrap got to before it threw. */
export type BootstrapStep = 'open-session-key' | 'otp-login' | 'funding-account';

/** Which entry point ran it: a fresh sign-in, or restoring on page load. */
export type BootstrapOrigin = 'sign-in' | 'reload';

const WHAT_EACH_STEP_DOES: Record<BootstrapStep, string> = {
  'open-session-key': "opening this browser's non-extractable signing key",
  'otp-login': 'installing that key as a Turnkey session (OTP_LOGIN)',
  'funding-account': 'deriving the Bitcoin funding account',
};

/** The operator-facing line. Names the step, so the next move is obvious. */
export function bootstrapFailureMessage(origin: BootstrapOrigin, step: BootstrapStep): string {
  return `[originals-demo] signing bootstrap failed during ${origin} while ${WHAT_EACH_STEP_DOES[step]} [step=${step}]`;
}

/** Report it. The error object is passed through unflattened so it stays inspectable. */
export function reportBootstrapFailure(
  origin: BootstrapOrigin,
  step: BootstrapStep,
  err: unknown,
  sink: Pick<Console, 'error'> = console
): void {
  sink.error(bootstrapFailureMessage(origin, step), err);
}

/**
 * Which prerequisite is missing before OTP_LOGIN can even be attempted.
 *
 * The two are checked in order, because the step reported has to be the step
 * that actually failed: a browser that opened its key fine but got no
 * verification token failed at OTP_LOGIN's prerequisite, not at the key. This
 * lives here, rather than as a ternary at the call site, so the mapping is
 * testable — mislabelling the step defeats the entire point of naming it.
 */
export function prerequisiteFailure(have: {
  sessionKey: boolean;
  verificationToken: boolean;
}): { step: BootstrapStep; reason: string } | null {
  if (!have.sessionKey) {
    return {
      step: 'open-session-key',
      reason: 'this browser could not open a signing key (IndexedDB or WebCrypto unavailable)',
    };
  }
  if (!have.verificationToken) {
    return {
      step: 'otp-login',
      reason: 'verify-otp returned no verificationToken, so OTP_LOGIN cannot run',
    };
  }
  return null;
}
