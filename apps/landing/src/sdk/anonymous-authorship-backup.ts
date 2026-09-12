import { getOrCreateWrappingKey, hasDurableKeyStore } from "./keystore";

const LOCAL_BACKUP_FORMAT = "originals/local-authorship-key-backup";
const LOCAL_BACKUP_VERSION = 1;

interface LocalAuthorshipBackup {
  format: typeof LOCAL_BACKUP_FORMAT;
  version: typeof LOCAL_BACKUP_VERSION;
  controller: string;
  ivBase64: string;
  ciphertextBase64: string;
}

export function anonymousAuthorshipStorageKey(assetId: string): string {
  return `originals:anonymous-authorship:${assetId}`;
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

/** True when this browser can hold a transparent local backup at all (#598). */
export function canPersistAnonymousAuthorshipKey(): boolean {
  return typeof localStorage !== "undefined" && hasDurableKeyStore();
}

/**
 * Transparently persist THIS asset's anonymous authoring key so a same-browser
 * reload can restore it instead of silently stranding edit capability (#598).
 *
 * The raw key is wrapped with this browser's own non-extractable wrapping
 * key (`keystore.ts`) before it ever reaches `storage`. Unlike encrypting
 * under a passphrase kept next to its own ciphertext, that wrapping key's
 * bits are never readable by any script — a copy of `storage` alone cannot
 * decrypt this record. A visitor who wants a backup portable to a
 * *different* browser should use `DemoEngine.exportAuthorshipKeyBackup`
 * instead, which encrypts under a passphrase the visitor themselves holds.
 */
export async function persistAnonymousAuthorshipKey(
  assetId: string,
  secretKey: Uint8Array,
  controller: string,
  storage: Storage = localStorage,
): Promise<void> {
  const wrappingKey = await getOrCreateWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBufferSource(iv) },
    wrappingKey,
    asBufferSource(secretKey),
  );
  const backup: LocalAuthorshipBackup = {
    format: LOCAL_BACKUP_FORMAT,
    version: LOCAL_BACKUP_VERSION,
    controller,
    ivBase64: toBase64(iv),
    ciphertextBase64: toBase64(new Uint8Array(ciphertext)),
  };
  storage.setItem(
    anonymousAuthorshipStorageKey(assetId),
    JSON.stringify(backup),
  );
}

export async function restoreAnonymousAuthorshipKey(
  assetId: string,
  storage: Storage = localStorage,
): Promise<{ secretKey: Uint8Array; controller: string } | null> {
  const raw = storage.getItem(anonymousAuthorshipStorageKey(assetId));
  if (!raw) return null;
  try {
    const backup = JSON.parse(raw) as LocalAuthorshipBackup;
    if (
      backup?.format !== LOCAL_BACKUP_FORMAT ||
      backup?.version !== LOCAL_BACKUP_VERSION
    )
      return null;
    const wrappingKey = await getOrCreateWrappingKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(fromBase64(backup.ivBase64)) },
      wrappingKey,
      asBufferSource(fromBase64(backup.ciphertextBase64)),
    );
    return { secretKey: new Uint8Array(plaintext), controller: backup.controller };
  } catch {
    return null;
  }
}
