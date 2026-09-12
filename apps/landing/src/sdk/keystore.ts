/**
 * Non-extractable AES-GCM wrapping key for this browser's local authorship
 * key backups (#598).
 *
 * A backup that encrypts under a passphrase generated and stored right next
 * to its own ciphertext gives no real confidentiality boundary: anything
 * that can read this browser's storage can read the passphrase too. A
 * non-extractable `CryptoKey` is different — once generated, its raw bits
 * can never be exported by any script, including this origin's own; the key
 * can only be *used*, through the handle, to encrypt/decrypt. Persisting
 * that handle across a reload needs IndexedDB, the only web storage that
 * can hold a live `CryptoKey` rather than a serialized value.
 *
 * This still does not defend against a script that can already execute on
 * this origin — such a script can call `decrypt` through the same handle
 * our own code uses. It does raise the bar against everything that can only
 * *read* this browser's storage: a storage-scoped extension, a raw profile/
 * disk copy, a devtools inspection of localStorage/IndexedDB values.
 */

const DB_NAME = "originals-authorship-keystore";
const DB_VERSION = 1;
const STORE_NAME = "wrapping-keys";
const WRAPPING_KEY_NAME = "anonymous-backup-wrapping-key";
const WRAPPING_KEY_LOCK_NAME = "originals:authorship-wrapping-key-init";

/**
 * Serialize first-use key creation, including across this origin's other
 * tabs. Without this, two concurrent first callers (e.g. two tabs open on
 * the same anonymous session) could each read "missing", each generate
 * their own key, and each `put` it — the second `put` wins, silently
 * orphaning whichever backup the first caller already encrypted under its
 * own, now-overwritten key. The Web Locks API is the standard way to
 * coordinate that across tabs; where it isn't available, this falls back to
 * running unsynchronized, same as before — still safe for the common single
 * caller case this test environment and most real sessions exercise.
 */
function withWrappingKeyLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request(WRAPPING_KEY_LOCK_NAME, fn);
  return fn();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("Could not open the browser key store."),
      );
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("Browser key store operation failed."),
      );
  });
}

/** True when this environment can persist a non-extractable CryptoKey at all. */
export function hasDurableKeyStore(): boolean {
  return typeof indexedDB !== "undefined";
}

/** This browser's wrapping key, generating and persisting one on first use. */
export async function getOrCreateWrappingKey(): Promise<CryptoKey> {
  if (!hasDurableKeyStore())
    throw new Error("This browser has no durable key store available.");

  return withWrappingKeyLock(async () => {
    const readDb = await openDb();
    let existing: CryptoKey | undefined;
    try {
      existing = await requestToPromise(
        readDb
          .transaction(STORE_NAME, "readonly")
          .objectStore(STORE_NAME)
          .get(WRAPPING_KEY_NAME) as IDBRequest<CryptoKey | undefined>,
      );
    } finally {
      readDb.close();
    }
    if (existing) return existing;

    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const writeDb = await openDb();
    try {
      await requestToPromise(
        writeDb
          .transaction(STORE_NAME, "readwrite")
          .objectStore(STORE_NAME)
          .put(key, WRAPPING_KEY_NAME),
      );
    } finally {
      writeDb.close();
    }
    return key;
  });
}
