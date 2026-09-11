import {
  encryptAuthorshipKey,
  decryptAuthorshipKey,
  type AuthorshipKeyBackup,
} from "./key-backup";

export function anonymousAuthorshipStorageKey(assetId: string): string {
  return `originals:anonymous-authorship:${assetId}`;
}

function randomPassphrase(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Transparently persist THIS asset's anonymous authoring key so a same-browser
 * reload can restore it instead of silently stranding edit capability (#598).
 * The key is AES-GCM encrypted under a passphrase generated and stored
 * alongside it — not the plain key, but not protected from an attacker who
 * can already run same-origin JS either. A visitor who wants a backup that
 * survives independently of this browser's storage should use
 * `DemoEngine.exportAuthorshipKeyBackup` with their own passphrase instead.
 */
export async function persistAnonymousAuthorshipKey(
  assetId: string,
  secretKey: Uint8Array,
  controller: string,
  storage: Storage = localStorage,
): Promise<void> {
  const passphrase = randomPassphrase();
  const backup = await encryptAuthorshipKey(secretKey, controller, passphrase);
  storage.setItem(
    anonymousAuthorshipStorageKey(assetId),
    JSON.stringify({ backup, passphrase }),
  );
}

export async function restoreAnonymousAuthorshipKey(
  assetId: string,
  storage: Storage = localStorage,
): Promise<{ secretKey: Uint8Array; controller: string } | null> {
  const raw = storage.getItem(anonymousAuthorshipStorageKey(assetId));
  if (!raw) return null;
  try {
    const { backup, passphrase } = JSON.parse(raw) as {
      backup: AuthorshipKeyBackup;
      passphrase: string;
    };
    const secretKey = await decryptAuthorshipKey(backup, passphrase);
    return { secretKey, controller: backup.controller };
  } catch {
    return null;
  }
}
