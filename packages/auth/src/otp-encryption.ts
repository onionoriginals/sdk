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

import { StructuredError } from '@originals/sdk';
import {
  compressRawPublicKey,
  encryptOtpCodeToBundle,
  generateP256KeyPair,
  uncompressRawPublicKey,
} from '@turnkey/crypto';
import { hexToBytes } from '@noble/hashes/utils.js';
import { AUTH_EMAIL_ERROR_CODES } from './error-codes.js';

/** Validate untrusted OTP inputs before encryption or session claiming. */
export function validateOtpInputs(otpCode: unknown, publicKey: unknown): void {
  // Keep in sync with initOtp's otpLength: 6, alphanumeric: false.
  if (typeof otpCode !== 'string' || !/^\d{6}$/.test(otpCode)) {
    throw new StructuredError(
      AUTH_EMAIL_ERROR_CODES.otpCodeFormatInvalid,
      'Invalid verification code format'
    );
  }

  // Only an omitted key allows server-side key generation.
  if (publicKey === undefined) return;
  if (
    typeof publicKey === 'string' &&
    /^(?:0[23][0-9a-f]{64}|04[0-9a-f]{128})$/i.test(publicKey)
  ) {
    try {
      // Validate curve membership as well as SEC1 encoding, without changing
      // the caller's encoding or including key material in errors.
      const bytes = hexToBytes(publicKey);
      const uncompressed = uncompressRawPublicKey(
        bytes.length === 33 ? bytes : compressRawPublicKey(bytes)
      );
      if (bytes.length === 33 || bytes.every((byte, index) => byte === uncompressed[index])) {
        return;
      }
    } catch {
      // Report the same input error for invalid points and invalid encodings.
    }
  }
  throw new StructuredError(
    AUTH_EMAIL_ERROR_CODES.otpPublicKeyInvalid,
    'Invalid OTP public key'
  );
}

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
   * Optional compressed or uncompressed P-256 public key (hex) to embed in
   * the encrypted bundle. When omitted, an ephemeral key pair is generated and its
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
  /** Compressed or uncompressed P-256 public key (hex) embedded in the encrypted bundle. */
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

  validateOtpInputs(otpCode, params.publicKey);

  if (!otpEncryptionTargetBundle) {
    throw new Error(
      'Missing otpEncryptionTargetBundle - Turnkey v6 initOtp must return a target encryption bundle'
    );
  }

  let publicKey = params.publicKey;
  let privateKey: string | undefined;

  if (publicKey === undefined) {
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
