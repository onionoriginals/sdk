import { createLocalSigner } from "@originals/sdk";
import { DemoEngine } from "./engine";
import { buildFetch } from "../../server/app";
import { createWebvhHostStore } from "../../server/webvh-host";
import { createOriginalsStore } from "../../server/originals-store";
import { createOriginalsRoutes } from "../../server/originals-routes";
import { signToken } from "@originals/auth/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HOST = "demo.test";
export const SECRET = "landing-test-secret-at-least-32-chars";

/**
 * Bun's test runtime has no `localStorage`/`indexedDB` globals (a real
 * browser always has both), so anonymous flows that back up their authoring
 * key there (#598) need them polyfilled explicitly. The fake IndexedDB only
 * implements the single-object-store open/get/put shape `keystore.ts`
 * actually uses — enough to exercise the same non-extractable-key code path
 * a real browser runs, not a general IndexedDB reimplementation. Call the
 * returned `restore()` in `afterEach`.
 */
export function installLocalStorage(): {
  storage: Storage;
  restore: () => void;
} {
  const oldStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const oldIndexedDB = Object.getOwnPropertyDescriptor(
    globalThis,
    "indexedDB",
  );
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });

  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  function makeRequest<T>(run: () => T): IDBRequest<T> {
    const request = {} as IDBRequest<T>;
    queueMicrotask(() => {
      try {
        (request as { result: T }).result = run();
        request.onsuccess?.(new Event("success"));
      } catch (error) {
        (request as { error: unknown }).error = error;
        request.onerror?.(new Event("error"));
      }
    });
    return request;
  }
  const fakeIndexedDB = {
    open(name: string) {
      let stores = databases.get(name);
      const isNew = !stores;
      if (!stores) {
        stores = new Map();
        databases.set(name, stores);
      }
      const capturedStores = stores;
      const request = {} as IDBOpenDBRequest;
      const db = {
        createObjectStore(storeName: string) {
          if (!capturedStores.has(storeName))
            capturedStores.set(storeName, new Map());
          return {} as IDBObjectStore;
        },
        transaction(storeName: string) {
          const store =
            capturedStores.get(storeName) ??
            capturedStores.set(storeName, new Map()).get(storeName)!;
          return {
            objectStore: () =>
              ({
                get: (key: string) => makeRequest(() => store.get(key)),
                put: (value: unknown, key: string) =>
                  makeRequest(() => {
                    store.set(key, value);
                    return key;
                  }),
                // Mirrors IDBObjectStore.add(): rejects with a
                // ConstraintError-shaped failure instead of overwriting when
                // the key is already present — what `keystore.ts` relies on
                // to make first-use wrapping-key creation a compare-and-swap.
                add: (value: unknown, key: string) =>
                  makeRequest(() => {
                    if (store.has(key)) {
                      const err = new Error(
                        `Key "${key}" already exists in the object store.`,
                      );
                      err.name = "ConstraintError";
                      throw err;
                    }
                    store.set(key, value);
                    return key;
                  }),
              }) as unknown as IDBObjectStore,
          } as unknown as IDBTransaction;
        },
        close() {},
      } as unknown as IDBDatabase;
      (request as { result: IDBDatabase }).result = db;
      queueMicrotask(() => {
        if (isNew)
          request.onupgradeneeded?.(new Event("upgradeneeded") as never);
        request.onsuccess?.(new Event("success"));
      });
      return request;
    },
  } as unknown as IDBFactory;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: fakeIndexedDB,
  });

  return {
    storage,
    restore() {
      if (oldStorage)
        Object.defineProperty(globalThis, "localStorage", oldStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
      if (oldIndexedDB)
        Object.defineProperty(globalThis, "indexedDB", oldIndexedDB);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    },
  };
}

export function installCel3Host(account?: string) {
  const real = globalThis.fetch;
  const { storage, restore: restoreStorage } = installLocalStorage();
  const dir = mkdtempSync(join(tmpdir(), "landing-cel3-"));
  const store = createOriginalsStore({ dataDir: dir });
  const originals = createOriginalsRoutes({ jwtSecret: SECRET, store });
  const hostStore = createWebvhHostStore();
  const serve = buildFetch({
    apiRoutes: {
      "POST /api/originals": originals.record,
      "GET /api/originals": originals.list,
    },
    hostStore,
    originals,
    distDir: "/nonexistent/",
  });
  const writes: string[] = [];
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString(),
      `https://${HOST}`,
    );
    requests.push(url.pathname);
    const headers = new Headers(init?.headers);
    if (account)
      headers.set(
        "authorization",
        `Bearer ${signToken(account, "test@example.com", undefined, { secret: SECRET })}`,
      );
    if (init?.method === "PUT") writes.push(decodeURIComponent(url.pathname));
    return serve(new Request(url, { ...init, headers }));
  }) as typeof fetch;
  globalThis.fetch = fetchImpl;
  (import.meta as unknown as { env: Record<string, string> }).env ??= {};
  (
    import.meta as unknown as { env: Record<string, string> }
  ).env.VITE_WEBVH_HOST = HOST;
  return {
    store,
    writes,
    requests,
    storage,
    fetch: fetchImpl,
    restore() {
      globalThis.fetch = real;
      restoreStorage();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export function engineWithSigner(account?: string) {
  const signer = createLocalSigner(
    "Ed25519",
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const engine = new DemoEngine(
    account ? { authed: true, subOrgId: account } : undefined,
  );
  Object.assign(engine, { authorshipSigner: signer });
  return { engine, signer };
}
