---
"@originals/auth": patch
---

Bump `@turnkey/sdk-server` from 5.3.0 to 6.1.1 and fix the resulting type break: `TurnkeyApiClient.verifyOtp` in v6 replaced its `otpCode` field with a required `encryptedOtpBundle`, which no longer type-checked against the existing plaintext OTP call sites in `src/client/turnkey-client.ts` (`completeOtp`) and `src/server/email-auth.ts` (`verifyEmailAuth`). Both call sites are preserved as-is (same runtime shape, same public function signatures) via a narrow type cast so the package builds and existing tests keep passing.

Note: Turnkey's v6 OTP verification flow now requires encrypting the OTP code client-side to the `otpEncryptionTargetBundle` returned by `initOtp` (via `encryptOtpCodeToBundle` from `@turnkey/crypto`) instead of sending it in plaintext. This patch keeps the pre-v6 plaintext call shape to unblock the dependency bump without changing public API, but the OTP verification flow will not succeed against the real Turnkey v6 API until it is migrated to the encrypted-bundle flow — see the `TODO(@turnkey-sdk-server-6)` comments left in both files.
