/**
 * Stable error codes for `initiateEmailAuth`/`verifyEmailAuth` failures
 * (#747). `otpVerifyTransientFailure` is distinct from `otpCodeIncorrect`:
 * transient failures do not consume the OTP attempt budget.
 */
export const AUTH_EMAIL_ERROR_CODES = {
  invalidEmailFormat: 'AUTH_EMAIL_INVALID_FORMAT',
  otpInitFailed: 'AUTH_OTP_INIT_FAILED',
  otpInitBundleMissing: 'AUTH_OTP_INIT_BUNDLE_MISSING',
  sessionInvalid: 'AUTH_SESSION_INVALID',
  sessionExpired: 'AUTH_SESSION_EXPIRED',
  sessionStateInvalid: 'AUTH_SESSION_STATE_INVALID',
  otpCodeFormatInvalid: 'AUTH_OTP_CODE_FORMAT_INVALID',
  otpPublicKeyInvalid: 'AUTH_OTP_PUBLIC_KEY_INVALID',
  otpEncryptionFailed: 'AUTH_OTP_ENCRYPTION_FAILED',
  otpCodeIncorrect: 'AUTH_OTP_CODE_INCORRECT',
  otpVerifyTransientFailure: 'AUTH_OTP_VERIFY_TRANSIENT_FAILURE',
  otpAttemptsExceeded: 'AUTH_OTP_ATTEMPTS_EXCEEDED',
  subOrgProvisionFailed: 'AUTH_SUBORG_PROVISION_FAILED',
  sessionAlreadyVerified: 'AUTH_SESSION_ALREADY_VERIFIED',
  otpVerifyInProgress: 'AUTH_OTP_VERIFY_IN_PROGRESS',
  sessionStorageClaimRequired: 'AUTH_SESSION_STORAGE_CLAIM_REQUIRED',
} as const;

