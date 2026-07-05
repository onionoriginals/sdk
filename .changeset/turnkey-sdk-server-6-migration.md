---
"@originals/auth": major
---

Migrate the OTP verification flow to the Turnkey v6 encrypted-bundle API (`@turnkey/sdk-server` 5.3.0 → 6.1.1, new dependency `@turnkey/crypto`).

Turnkey v6 replaced plaintext OTP verification: `initOtp` (ACTIVITY_TYPE_INIT_OTP_V3) now returns an `otpEncryptionTargetBundle` (a signed bundle containing a target encryption key), and `verifyOtp` (ACTIVITY_TYPE_VERIFY_OTP_V2) requires an `encryptedOtpBundle` — the OTP code plus a client-generated P-256 public key, HPKE-encrypted to that target key — instead of the previous plaintext `otpCode` field. The previous release preserved the pre-v6 plaintext call shape behind a type cast, which type-checked but could not succeed against the real Turnkey v6 API.

Changes:

- New `encryptOtpCode()` helper (exported from both `@originals/auth/client` and `@originals/auth/server`) wraps `encryptOtpCodeToBundle` from `@turnkey/crypto`: it verifies the enclave signature on the target bundle, generates an ephemeral P-256 key pair when none is supplied, and produces the `encryptedOtpBundle` for `verifyOtp`.
- `initiateEmailAuth()` (server) now captures `otpEncryptionTargetBundle` from the init-OTP result and stores it on the auth session (`EmailAuthSession.otpEncryptionTargetBundle`); it fails fast if Turnkey does not return one.
- `verifyEmailAuth()` (server) encrypts the user's OTP code to the session's target bundle and submits it as `encryptedOtpBundle`. Its signature gains an optional trailing `options` parameter (`dangerouslyOverrideSignerPublicKey`, for tests/non-production Turnkey environments only) and its result now includes the Turnkey `verificationToken` (optional field, for use with OTP_LOGIN).

BREAKING (client module):

- `initOtp()` now returns `{ otpId, otpEncryptionTargetBundle }` instead of a bare `otpId` string.
- `completeOtp()` now requires the `otpEncryptionTargetBundle` from `initOtp` as its fifth argument (plus optional `CompleteOtpOptions`), and returns `{ verificationToken, subOrgId, publicKey, privateKey? }` — the key pair the verification token is bound to, needed for a subsequent `otpLogin`.

Sessions created before this release (without a stored `otpEncryptionTargetBundle`) cannot be verified and will be asked to request a new code.
