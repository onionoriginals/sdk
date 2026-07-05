/**
 * Test utilities for the Turnkey v6 OTP encrypted-bundle flow.
 *
 * Builds a validly-signed `otpEncryptionTargetBundle` using a locally
 * generated "enclave signer" key so that the REAL `encryptOtpCodeToBundle`
 * from @turnkey/crypto can run end-to-end in unit tests (via the
 * `dangerouslyOverrideSignerPublicKey` test hook) — without any live Turnkey
 * API access. The bundle format mirrors what Turnkey's enclaves return from
 * initOtp: `{ enclaveQuorumPublic, dataSignature, data }` where `data` is the
 * hex-encoded JSON `{ targetPublic }`.
 */

import { generateKeyPairSync, createSign } from 'node:crypto';
import {
  generateP256KeyPair,
  fromDerSignature,
  toDerSignature,
  hpkeDecrypt,
} from '@turnkey/crypto';

/** P-256 curve order (for low-s signature normalization). */
const P256_N = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'
);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface OtpTargetBundleFixture {
  /** JSON target bundle, as returned by Turnkey initOtp (v6). */
  otpEncryptionTargetBundle: string;
  /** Uncompressed hex public key of the test "enclave signer". Pass as dangerouslyOverrideSignerPublicKey. */
  signerPublicKey: string;
  /** Hex private key of the HPKE target key; use to decrypt produced bundles. */
  targetPrivateKey: string;
  /** Uncompressed hex public key of the HPKE target key. */
  targetPublicKey: string;
}

/**
 * Create a validly-signed OTP encryption target bundle with test keys.
 */
export function createOtpTargetBundle(): OtpTargetBundleFixture {
  // "Enclave signer" key pair (P-256, via node:crypto so we can sign)
  const { publicKey: signerPub, privateKey: signerPriv } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  // SPKI DER for P-256 ends with the 65-byte uncompressed public point
  const spki = signerPub.export({ type: 'spki', format: 'der' }) as Buffer;
  const signerPublicKey = bytesToHex(new Uint8Array(spki.subarray(spki.length - 65)));

  // HPKE target key pair (what the enclave would encrypt-to)
  const target = generateP256KeyPair();

  // Signed payload: hex-encoded JSON { targetPublic }
  const signedDataJson = JSON.stringify({ targetPublic: target.publicKeyUncompressed });
  const dataHex = bytesToHex(new TextEncoder().encode(signedDataJson));

  // ECDSA-SHA256 over the data bytes, DER-encoded, normalized to low-s
  // (matches @turnkey/crypto's verifyEnclaveSignature expectations)
  const derSig = createSign('SHA256')
    .update(Buffer.from(dataHex, 'hex'))
    .sign({ key: signerPriv, dsaEncoding: 'der' });
  const rawSig = fromDerSignature(bytesToHex(new Uint8Array(derSig)));
  const r = BigInt('0x' + bytesToHex(rawSig.slice(0, 32)));
  let s = BigInt('0x' + bytesToHex(rawSig.slice(32, 64)));
  if (s > P256_N / 2n) {
    s = P256_N - s;
  }
  const dataSignature = toDerSignature(
    r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0')
  );

  const otpEncryptionTargetBundle = JSON.stringify({
    enclaveQuorumPublic: signerPublicKey,
    dataSignature,
    data: dataHex,
  });

  return {
    otpEncryptionTargetBundle,
    signerPublicKey,
    targetPrivateKey: target.privateKey,
    targetPublicKey: target.publicKeyUncompressed,
  };
}

/**
 * Decrypt an `encryptedOtpBundle` produced by the SDK using the test target
 * private key, returning the plaintext payload `{ otp_code, public_key }`.
 */
export function decryptOtpBundle(
  encryptedOtpBundle: string,
  targetPrivateKey: string
): { otp_code: string; public_key: string } {
  const parsed = JSON.parse(encryptedOtpBundle) as {
    encappedPublic: string;
    ciphertext: string;
  };
  const plaintext = hpkeDecrypt({
    ciphertextBuf: hexToBytes(parsed.ciphertext),
    encappedKeyBuf: hexToBytes(parsed.encappedPublic),
    receiverPriv: targetPrivateKey,
  });
  return JSON.parse(new TextDecoder().decode(plaintext));
}
