/**
 * OTP encrypted-bundle helpers for the Turnkey v6 OTP verification flow.
 *
 * Since @turnkey/sdk-server v6, `verifyOtp` (ACTIVITY_TYPE_VERIFY_OTP_V2) no
 * longer accepts a plaintext `otpCode`. Instead the OTP code must be
 * HPKE-encrypted client-side to the `otpEncryptionTargetBundle` returned by
 * `initOtp` (ACTIVITY_TYPE_INIT_OTP_V3), and submitted as `encryptedOtpBundle`.
 *
 * The encrypted bundle contains the OTP code and a client-generated P-256
 * public key. Turnkey's secure enclaves decrypt the bundle, verify the OTP
 * code, and issue a verification token bound to that public key (which can
 * then be used with `otpLogin`).
 *
 * This module wraps `encryptOtpCodeToBundle` from @turnkey/crypto, which also
 * verifies the enclave signature on the target bundle before encrypting.
 */

import { encryptOtpCodeToBundle, generateP256KeyPair } from '@turnkey/crypto';

/**
 * Parameters for {@link encryptOtpCode}.
 */
export interface EncryptOtpCodeParams {
  /** The OTP code entered by the user. */
  otpCode: string;
  /**
   * The signed target-encryption bundle returned by the `initOtp` activity
   * (`otpEncryptionTargetBundle` on the init-OTP result).
   */
  otpEncryptionTargetBundle: string;
  /**
   * Optional compressed P-256 public key (hex) to embed in the encrypted
   * bundle. When omitted, an ephemeral P-256 key pair is generated and its
   * private key is returned so the caller can complete a subsequent
   * `otpLogin` bound to the same key.
   */
  publicKey?: string;
  /**
   * Override for the enclave (TLS fetcher) signing key used to verify the
   * target bundle's signature. ONLY for tests or non-production Turnkey
   * environments; defaults to Turnkey's production signer key.
   */
  dangerouslyOverrideSignerPublicKey?: string;
}

/**
 * Result of {@link encryptOtpCode}.
 */
export interface EncryptOtpCodeResult {
  /** The encrypted OTP bundle to pass as `encryptedOtpBundle` to `verifyOtp`. */
  encryptedOtpBundle: string;
  /** Compressed P-256 public key (hex) embedded in the encrypted bundle. */
  publicKey: string;
  /**
   * Private key (hex) for the ephemeral key pair, present only when the key
   * pair was generated internally (i.e. no `publicKey` was supplied).
   * Sensitive: handle with care and never log.
   */
  privateKey?: string;
}

/**
 * Encrypt an OTP code (plus a client public key) to the target encryption key
 * from an init-OTP result, producing the `encryptedOtpBundle` required by
 * Turnkey v6 `verifyOtp`.
 *
 * Verifies the enclave signature on the target bundle before encrypting and
 * throws if verification fails.
 */
export async function encryptOtpCode(
  params: EncryptOtpCodeParams
): Promise<EncryptOtpCodeResult> {
  const { otpCode, otpEncryptionTargetBundle, dangerouslyOverrideSignerPublicKey } = params;

  if (!otpEncryptionTargetBundle) {
    throw new Error(
      'Missing otpEncryptionTargetBundle - Turnkey v6 initOtp must return a target encryption bundle'
    );
  }

  let publicKey = params.publicKey;
  let privateKey: string | undefined;

  if (!publicKey) {
    const keyPair = generateP256KeyPair();
    publicKey = keyPair.publicKey;
    privateKey = keyPair.privateKey;
  }

  const encryptedOtpBundle = await encryptOtpCodeToBundle(
    otpCode,
    otpEncryptionTargetBundle,
    publicKey,
    dangerouslyOverrideSignerPublicKey
  );

  return { encryptedOtpBundle, publicKey, privateKey };
}
