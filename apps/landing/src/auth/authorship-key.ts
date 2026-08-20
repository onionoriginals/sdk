/**
 * U10 / R17, R18 — the authorship key.
 *
 * The Ed25519 seed in `webvh.ts` signs every Original the user authors, and it
 * exists in exactly one place: this browser's `localStorage`. Clearing site
 * data, switching browsers, or Safari evicting storage all destroy it, and
 * nothing on our side can reissue it. KTD10 says the launch remedy is
 * warn-and-export rather than recovery, so this module is that remedy:
 *
 *  - an acknowledgement gate that must be recorded BEFORE a key can be
 *    generated (`webvh.ts` refuses to mint one otherwise), and
 *  - a passphrase-wrapped backup of both pieces of browser-only state.
 *
 * Both pieces, not just the seed: the DID is not derivable from the seed. The
 * first log entry's `versionTime` feeds the SCID, so re-creating from a seed
 * alone yields a DIFFERENT did:webvh than the one the user's Originals were
 * authored under. The log travels with the seed or the restore is worthless.
 *
 * Nothing here touches the network. WebCrypto only — no new dependencies.
 */

/** Storage keys. These MUST stay byte-identical to the ones `webvh.ts` writes. */
export const KEY_STORAGE_PREFIX = 'originals-webvh-ed25519';
export const DID_LOG_STORAGE_PREFIX = 'originals-webvh-did-log';
const ACK_STORAGE_PREFIX = 'originals-authorship-key-ack';

export const BACKUP_FORMAT = 'originals-authorship-key-backup';
export const BACKUP_VERSION = 1;

/**
 * PBKDF2-HMAC-SHA-256 at 600k iterations — OWASP's current floor for this KDF,
 * and the highest cost a browser can pay in well under a second. The backup
 * file is expected to sit in a Downloads folder, a cloud sync, or an inbox, so
 * it is sized against an offline attacker with the file in hand.
 */
export const PBKDF2_ITERATIONS = 600_000;
/**
 * And a CEILING. `iterations` is attacker-controlled input on the restore
 * path — the one a user reaches when they have already lost a key — so an
 * unbounded count is a file that hangs the tab. Far above what we write.
 */
export const PBKDF2_MAX_ITERATIONS = 5_000_000;
/** A wrong-passphrase failure must be indistinguishable from a mangled file. */
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MIN_PASSPHRASE_LENGTH = 10;

/** Codes are lowercase tokens, never sentences: the copy lives in content.ts. */
export type AuthorshipKeyErrorCode =
  | 'not-acknowledged'
  | 'weak-passphrase'
  | 'wrong-passphrase'
  | 'malformed-backup'
  | 'replace-not-acknowledged'
  | 'no-key';

export class AuthorshipKeyError extends Error {
  constructor(readonly code: AuthorshipKeyErrorCode, message: string) {
    super(message);
    this.name = 'AuthorshipKeyError';
  }
}

/** The plaintext of a backup: everything a second browser needs, and no more. */
export interface AuthorshipKeyBackup {
  /** The Ed25519 seed, hex — the encoding `webvh.ts` already persists. */
  seedHex: string;
  /** The persisted did:webvh log. Carries the DID; the seed alone does not. */
  didLog: unknown;
}

/** The on-disk file. Contains no key material recoverable without the passphrase. */
export interface EncryptedAuthorshipKeyFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  ciphertext: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < out.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Bound into the AES-GCM tag so a file cannot be replayed under a different
 * format or version header — tampering with the header fails authentication
 * rather than silently changing how the ciphertext is read.
 */
function additionalData(version: number): BufferSource {
  return asBuffer(new TextEncoder().encode(`${BACKUP_FORMAT}/${version}`));
}

/** WebCrypto's `BufferSource` pins ArrayBuffer; `Uint8Array` does not. */
function asBuffer(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    asBuffer(new TextEncoder().encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Rejects a passphrase too short to be worth the KDF. */
export function passphraseProblem(passphrase: string): 'weak-passphrase' | null {
  return passphrase.trim().length < MIN_PASSPHRASE_LENGTH ? 'weak-passphrase' : null;
}

/**
 * Encrypt a backup. Salt and nonce are freshly random per call, so two exports
 * of the same seed under the same passphrase share neither key nor key stream.
 */
export async function encryptAuthorshipKey(
  backup: AuthorshipKeyBackup,
  passphrase: string
): Promise<EncryptedAuthorshipKeyFile> {
  if (passphraseProblem(passphrase)) {
    throw new AuthorshipKeyError('weak-passphrase', 'Backup passphrase is too short');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(backup));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv), additionalData: additionalData(BACKUP_VERSION) },
    key,
    asBuffer(plaintext)
  );
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

function isEncryptedFile(value: unknown): value is EncryptedAuthorshipKeyFile {
  const file = value as EncryptedAuthorshipKeyFile | null;
  return (
    !!file &&
    typeof file === 'object' &&
    file.format === BACKUP_FORMAT &&
    Number.isInteger(file.version) &&
    file.version >= 1 &&
    file.version <= BACKUP_VERSION &&
    !!file.kdf &&
    file.kdf.name === 'PBKDF2' &&
    file.kdf.hash === 'SHA-256' &&
    Number.isInteger(file.kdf.iterations) &&
    file.kdf.iterations >= 100_000 &&
    file.kdf.iterations <= PBKDF2_MAX_ITERATIONS &&
    typeof file.kdf.salt === 'string' &&
    !!file.cipher &&
    file.cipher.name === 'AES-GCM' &&
    typeof file.cipher.iv === 'string' &&
    typeof file.ciphertext === 'string' &&
    file.ciphertext.length > 0
  );
}

/** A restored payload is only usable if BOTH the seed and the log survived it. */
function isBackup(value: unknown): value is AuthorshipKeyBackup {
  const backup = value as AuthorshipKeyBackup | null;
  if (!backup || typeof backup !== 'object') return false;
  if (typeof backup.seedHex !== 'string' || !/^[0-9a-f]{64}$/.test(backup.seedHex)) return false;
  return didFromLog(backup.didLog) !== null;
}

/** The DID a persisted did:webvh log resolves to: the latest entry's `state.id`. */
export function didFromLog(didLog: unknown): string | null {
  if (!Array.isArray(didLog) || didLog.length === 0) return null;
  const state = (didLog[didLog.length - 1] as { state?: { id?: unknown } } | null)?.state;
  const id = state?.id;
  return typeof id === 'string' && id.startsWith('did:webvh:') ? id : null;
}

/**
 * Decrypt a backup. Every failure — a file that is not ours, a truncated one,
 * a wrong passphrase — throws BEFORE anything is written, so a failed restore
 * cannot destroy the key already in the browser.
 */
export async function decryptAuthorshipKey(
  file: unknown,
  passphrase: string
): Promise<AuthorshipKeyBackup> {
  if (!isEncryptedFile(file)) {
    throw new AuthorshipKeyError('malformed-backup', 'Not an Originals authorship key backup');
  }
  let salt: Uint8Array;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = fromBase64(file.kdf.salt);
    iv = fromBase64(file.cipher.iv);
    ciphertext = fromBase64(file.ciphertext);
  } catch {
    throw new AuthorshipKeyError('malformed-backup', 'Backup file is corrupt');
  }
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length === 0) {
    throw new AuthorshipKeyError('malformed-backup', 'Backup file is corrupt');
  }
  const key = await deriveKey(passphrase, salt, file.kdf.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBuffer(iv), additionalData: additionalData(file.version) },
      key,
      asBuffer(ciphertext)
    );
  } catch {
    // AES-GCM cannot tell a wrong passphrase from a tampered file, and neither can we.
    throw new AuthorshipKeyError('wrong-passphrase', 'Wrong passphrase for this backup');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new AuthorshipKeyError('malformed-backup', 'Backup contents are unreadable');
  }
  if (!isBackup(parsed)) {
    throw new AuthorshipKeyError('malformed-backup', 'Backup is missing the key or the DID log');
  }
  return parsed;
}

/**
 * The download filename. Deliberately carries no email and no DID: it lands in
 * a Downloads folder and often a cloud sync, where the name is the one part
 * everyone sees. The date is there so two backups sort, not to identify anyone.
 */
export function backupFileName(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `originals-authorship-key-${day}.json`;
}

function keyStorageKey(subOrgId: string): string {
  return `${KEY_STORAGE_PREFIX}:${subOrgId}`;
}

function logStorageKey(subOrgId: string): string {
  return `${DID_LOG_STORAGE_PREFIX}:${subOrgId}`;
}

/** Read the browser-only state as a backup payload, or null when there is none. */
export function readAuthorshipKey(storage: Storage, subOrgId: string): AuthorshipKeyBackup | null {
  const seedHex = storage.getItem(keyStorageKey(subOrgId));
  const rawLog = storage.getItem(logStorageKey(subOrgId));
  if (!seedHex || !rawLog) return null;
  try {
    const backup = { seedHex, didLog: JSON.parse(rawLog) };
    return isBackup(backup) ? backup : null;
  } catch {
    return null;
  }
}

/** Write a restored backup into this browser. Validated first, then both keys. */
export function writeAuthorshipKey(storage: Storage, subOrgId: string, backup: AuthorshipKeyBackup): void {
  if (!isBackup(backup)) {
    throw new AuthorshipKeyError('malformed-backup', 'Refusing to store an incomplete backup');
  }
  storage.setItem(keyStorageKey(subOrgId), backup.seedHex);
  storage.setItem(logStorageKey(subOrgId), JSON.stringify(backup.didLog));
  // A restored key needs no warning gate — the user already has one to lose.
  acknowledgeKeyLoss(storage, subOrgId);
}

export function hasAuthorshipKey(storage: Storage, subOrgId: string): boolean {
  return storage.getItem(keyStorageKey(subOrgId)) !== null;
}

/**
 * What a restore would do to this browser. `replaces-key` is the case that
 * must warn first: a silent overwrite orphans every Original authored under
 * the key being replaced.
 */
export function classifyRestore(
  existing: AuthorshipKeyBackup | null,
  incoming: AuthorshipKeyBackup
): 'fresh' | 'same-key' | 'replaces-key' {
  if (!existing) return 'fresh';
  return existing.seedHex === incoming.seedHex ? 'same-key' : 'replaces-key';
}

/** Export the current browser's key, wrapped. Throws when there is nothing to export. */
export async function exportAuthorshipKey(
  storage: Storage,
  subOrgId: string,
  passphrase: string
): Promise<EncryptedAuthorshipKeyFile> {
  const backup = readAuthorshipKey(storage, subOrgId);
  if (!backup) throw new AuthorshipKeyError('no-key', 'No authorship key in this browser');
  return encryptAuthorshipKey(backup, passphrase);
}

/**
 * Restore a backup into this browser. `allowReplace` is the caller's proof that
 * the replace warning was shown and accepted; without it a restore over a
 * different key refuses rather than overwriting.
 */
export async function importAuthorshipKey(
  storage: Storage,
  subOrgId: string,
  file: unknown,
  passphrase: string,
  opts: { allowReplace?: boolean } = {}
): Promise<{ outcome: 'fresh' | 'same-key' | 'replaces-key'; did: string }> {
  const incoming = await decryptAuthorshipKey(file, passphrase);
  const outcome = classifyRestore(readAuthorshipKey(storage, subOrgId), incoming);
  if (outcome === 'replaces-key' && !opts.allowReplace) {
    throw new AuthorshipKeyError(
      'replace-not-acknowledged',
      'A different key is already in this browser'
    );
  }
  writeAuthorshipKey(storage, subOrgId, incoming);
  return { outcome, did: didFromLog(incoming.didLog)! };
}

/**
 * Parse a chosen file's text. Kept here so the UI never has to guess whether a
 * JSON parse failure and a bad backup are different errors — they are not.
 */
export function parseBackupFile(text: string): EncryptedAuthorshipKeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AuthorshipKeyError('malformed-backup', 'Not an Originals authorship key backup');
  }
  if (!isEncryptedFile(parsed)) {
    throw new AuthorshipKeyError('malformed-backup', 'Not an Originals authorship key backup');
  }
  return parsed;
}

/* ——— the warning gate ——— */

function ackStorageKey(subOrgId: string): string {
  return `${ACK_STORAGE_PREFIX}:${subOrgId}`;
}

export function hasAcknowledgedKeyLoss(storage: Storage, subOrgId: string): boolean {
  return storage.getItem(ackStorageKey(subOrgId)) !== null;
}

export function acknowledgeKeyLoss(storage: Storage, subOrgId: string): void {
  storage.setItem(ackStorageKey(subOrgId), new Date().toISOString());
}

export { browserKeyStorage } from './browser-storage';
