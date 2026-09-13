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

/**
 * This browser's wrapping key, generating and persisting one on first use.
 *
 * Two concurrent first callers (e.g. two tabs open on the same anonymous
 * session) can each read "missing" before either has written anything. To
 * stay correct in that case without depending on the Web Locks API (not
 * available in every supported browser), the write is a compare-and-swap:
 * `add()` only succeeds for whichever caller writes first, since IndexedDB
 * itself rejects a second `add()` under the same key with a
 * `ConstraintError`. The loser discards its own freshly generated candidate
 * and re-reads the key the winner actually persisted, so every caller ends
 * up encrypting under the one durable key regardless of who generated it.
 */
export async function getOrCreateWrappingKey(): Promise<CryptoKey> {
  if (!hasDurableKeyStore())
    throw new Error("This browser has no durable key store available.");

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

  const candidate = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  const writeDb = await openDb();
  try {
    const store = writeDb.transaction(STORE_NAME, "readwrite").objectStore(
      STORE_NAME,
    );
    try {
      await requestToPromise(store.add(candidate, WRAPPING_KEY_NAME));
      return candidate;
    } catch {
      // Another caller's `add()` won the race in the meantime — use the key
      // it actually persisted instead of our own, now-discarded candidate.
      const winner = await requestToPromise(
        writeDb
          .transaction(STORE_NAME, "readonly")
          .objectStore(STORE_NAME)
          .get(WRAPPING_KEY_NAME) as IDBRequest<CryptoKey | undefined>,
      );
      if (!winner)
        throw new Error("Could not read or create the browser wrapping key.");
      return winner;
    }
  } finally {
    writeDb.close();
  }
}
