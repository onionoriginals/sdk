/**
 * Encrypted backup for a locally-held Ed25519 authoring key (#598).
 *
 * AES-256-GCM with a PBKDF2-SHA256 derived key. The secret key bytes never
 * appear in the returned backup except as ciphertext — callers decide where
 * the backup itself is written, this module never touches storage.
 */

const PBKDF2_ITERATIONS = 210_000;
const BACKUP_FORMAT = "originals/authorship-key-backup";
const BACKUP_VERSION = 1;
const MIN_PASSPHRASE_LENGTH = 8;

export interface AuthorshipKeyBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  algorithm: "Ed25519";
  controller: string;
  saltBase64: string;
  ivBase64: string;
  ciphertextBase64: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

// TS's DOM lib wants BufferSource views backed by a concrete ArrayBuffer;
// Uint8Array is typed over the wider ArrayBufferLike. The bytes are identical
// either way — this only satisfies the type checker.
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: asBufferSource(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a raw Ed25519 secret key under a passphrase. */
export async function encryptAuthorshipKey(
  secretKey: Uint8Array,
  controller: string,
  passphrase: string,
): Promise<AuthorshipKeyBackup> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH)
    throw new Error(
      `Choose a backup passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBufferSource(iv) },
    key,
    asBufferSource(secretKey),
  );
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    algorithm: "Ed25519",
    controller,
    saltBase64: toBase64(salt),
    ivBase64: toBase64(iv),
    ciphertextBase64: toBase64(new Uint8Array(ciphertext)),
  };
}

/** Decrypt a backup produced by `encryptAuthorshipKey`. Throws on a wrong passphrase or a malformed/foreign backup. */
export async function decryptAuthorshipKey(
  backup: AuthorshipKeyBackup,
  passphrase: string,
): Promise<Uint8Array> {
  if (backup?.format !== BACKUP_FORMAT || backup?.version !== BACKUP_VERSION)
    throw new Error("Unrecognized authorship key backup format.");
  const salt = fromBase64(backup.saltBase64);
  const iv = fromBase64(backup.ivBase64);
  const key = await deriveAesKey(passphrase, salt);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(iv) },
      key,
      asBufferSource(fromBase64(backup.ciphertextBase64)),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error(
      "Could not restore this backup — the passphrase is wrong, or the backup is corrupted.",
    );
  }
}
