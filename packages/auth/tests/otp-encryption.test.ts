/**
 * Unit tests for the Turnkey v6 OTP encrypted-bundle helper.
 *
 * NOTE: these tests run the REAL @turnkey/crypto encryption (HPKE + enclave
 * signature verification) against locally generated test keys via the
 * `dangerouslyOverrideSignerPublicKey` hook. They do NOT talk to the live
 * Turnkey API — no credentials are available in CI — so the enclave side of
 * the flow (decryption + token issuance) is not exercised here.
 */

import { describe, test, expect } from 'bun:test';
import { generateP256KeyPair } from '@turnkey/crypto';
import { encryptOtpCode } from '../src/otp-encryption';
import { createOtpTargetBundle, decryptOtpBundle } from './helpers/otp-test-utils';

describe('otp-encryption', () => {
  describe('encryptOtpCode', () => {
    test('encrypts the OTP code to the target bundle (round-trip)', async () => {
      const fixture = createOtpTargetBundle();

      const result = await encryptOtpCode({
        otpCode: '123456',
        otpEncryptionTargetBundle: fixture.otpEncryptionTargetBundle,
        dangerouslyOverrideSignerPublicKey: fixture.signerPublicKey,
      });

      expect(result.encryptedOtpBundle).toBeString();
      // Bundle is JSON with encappedPublic + ciphertext (formatHpkeBuf shape)
      const parsed = JSON.parse(result.encryptedOtpBundle);
      expect(parsed.encappedPublic).toMatch(/^04[0-9a-f]{128}$/);
      expect(parsed.ciphertext).toMatch(/^[0-9a-f]+$/);

      // Decrypt with the target private key and verify the payload
      const plaintext = decryptOtpBundle(result.encryptedOtpBundle, fixture.targetPrivateKey);
      expect(plaintext.otp_code).toBe('123456');
      expect(plaintext.public_key).toBe(result.publicKey);
    });

    test('generates an ephemeral key pair when none is provided', async () => {
      const fixture = createOtpTargetBundle();

      const result = await encryptOtpCode({
        otpCode: '654321',
        otpEncryptionTargetBundle: fixture.otpEncryptionTargetBundle,
        dangerouslyOverrideSignerPublicKey: fixture.signerPublicKey,
      });

      // Compressed P-256 public key (33 bytes hex) and matching private key
      expect(result.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
      expect(result.privateKey).toMatch(/^[0-9a-f]{64}$/);
    });

    test('uses the caller-provided public key and returns no private key', async () => {
      const fixture = createOtpTargetBundle();
      const callerKey = generateP256KeyPair();

      const result = await encryptOtpCode({
        otpCode: '111222',
        otpEncryptionTargetBundle: fixture.otpEncryptionTargetBundle,
        publicKey: callerKey.publicKey,
        dangerouslyOverrideSignerPublicKey: fixture.signerPublicKey,
      });

      expect(result.publicKey).toBe(callerKey.publicKey);
      expect(result.privateKey).toBeUndefined();

      const plaintext = decryptOtpBundle(result.encryptedOtpBundle, fixture.targetPrivateKey);
      expect(plaintext.public_key).toBe(callerKey.publicKey);
    });

    test('rejects a target bundle signed by an unexpected key', async () => {
      const fixture = createOtpTargetBundle();
      const wrongSigner = generateP256KeyPair();

      await expect(
        encryptOtpCode({
          otpCode: '123456',
          otpEncryptionTargetBundle: fixture.otpEncryptionTargetBundle,
          dangerouslyOverrideSignerPublicKey: wrongSigner.publicKeyUncompressed,
        })
      ).rejects.toThrow();
    });

    test('rejects a tampered target bundle (bad signature)', async () => {
      const fixture = createOtpTargetBundle();
      const parsed = JSON.parse(fixture.otpEncryptionTargetBundle);
      // Tamper with the signed data: swap the target key for an attacker key
      const attackerTarget = generateP256KeyPair();
      const tamperedJson = JSON.stringify({ targetPublic: attackerTarget.publicKeyUncompressed });
      parsed.data = Array.from(new TextEncoder().encode(tamperedJson))
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join('');

      await expect(
        encryptOtpCode({
          otpCode: '123456',
          otpEncryptionTargetBundle: JSON.stringify(parsed),
          dangerouslyOverrideSignerPublicKey: fixture.signerPublicKey,
        })
      ).rejects.toThrow();
    });

    test('rejects a missing target bundle', async () => {
      await expect(
        encryptOtpCode({
          otpCode: '123456',
          otpEncryptionTargetBundle: '',
        })
      ).rejects.toThrow('Missing otpEncryptionTargetBundle');
    });

    test('rejects a malformed target bundle', async () => {
      await expect(
        encryptOtpCode({
          otpCode: '123456',
          otpEncryptionTargetBundle: 'not-json',
        })
      ).rejects.toThrow();
    });

    test('produces unique bundles per call (fresh ephemeral keys)', async () => {
      const fixture = createOtpTargetBundle();
      const a = await encryptOtpCode({
        otpCode: '123456',
        otpEncryptionTargetBundle: fixture.otpEncryptionTargetBundle,
        dangerouslyOverrideSignerPublicKey: fixture.signerPublicKey,
      });
      const b = await encryptOtpCode({
        otpCode: '123456',
        otpEncryptionTargetBundle: fixture.otpEncryptionTargetBundle,
        dangerouslyOverrideSignerPublicKey: fixture.signerPublicKey,
      });
      expect(a.encryptedOtpBundle).not.toBe(b.encryptedOtpBundle);
      expect(a.publicKey).not.toBe(b.publicKey);
    });
  });
});
