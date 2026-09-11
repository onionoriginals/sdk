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
 * Bun's test runtime has no `localStorage` global (a real browser always
 * does), so anonymous flows that now back up their authoring key there
 * (#598) need it polyfilled explicitly. Call the returned `restore()` in
 * `afterEach`.
 */
export function installLocalStorage(): {
  storage: Storage;
  restore: () => void;
} {
  const oldStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
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
  return {
    storage,
    restore() {
      if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
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
