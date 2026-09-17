/**
 * #698 — OriginalsSDK3's constructor mishandles the `storageAdapter` option:
 *
 * 1. A malformed value used to crash with a raw `TypeError` from the `"putObject"
 *    in storageAdapter` check (`in` throws when its right-hand side is not an
 *    object) instead of a structured, catchable error.
 * 2. A pure new-style adapter (putObject/getObject/exists, no put/get) was used
 *    to build `hostedStorage` for explicit hosted publication, but never copied
 *    onto `this.config.storageAdapter` — so every duck-typed consumer that reads
 *    `config.storageAdapter` directly (AssetDIDManager/DIDManager's
 *    `readStoredCelLog`, the previous-format LifecycleManager) saw no adapter at
 *    all, even though the constructor accepted one.
 */
import { describe, expect, test } from "bun:test";
import { CelError } from "@originals/cel/v3";
import { OriginalsSDK } from "../../../src/index.js";

describe("OriginalsSDK3 storageAdapter option (#698)", () => {
  test("a malformed storageAdapter throws a structured error, not a raw TypeError", () => {
    let thrown: unknown;
    try {
      OriginalsSDK.create({ storageAdapter: "not-an-adapter" as never });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CelError);
    expect((thrown as CelError).code).toBe("SDK_STORAGE_ADAPTER");
  });

  test("an object implementing neither put() nor putObject() is also rejected structurally", () => {
    let thrown: unknown;
    try {
      OriginalsSDK.create({ storageAdapter: { irrelevant: true } as never });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CelError);
    expect((thrown as CelError).code).toBe("SDK_STORAGE_ADAPTER");
  });

  test("undefined storageAdapter leaves config.storageAdapter unset", () => {
    const sdk = OriginalsSDK.create({});
    expect((sdk as unknown as { config: { storageAdapter?: unknown } }).config.storageAdapter).toBeUndefined();
  });

  test("a legacy-shape adapter (put/get) is forwarded onto config.storageAdapter", () => {
    const legacyAdapter = {
      put: async () => "https://example.com/x",
      get: async () => null,
    };
    const sdk = OriginalsSDK.create({ storageAdapter: legacyAdapter });
    expect((sdk as unknown as { config: { storageAdapter?: unknown } }).config.storageAdapter).toBe(legacyAdapter);
  });

  test("a pure new-style adapter (putObject/getObject/exists) is ALSO forwarded onto config.storageAdapter, not silently dropped", () => {
    const newStyleAdapter = {
      putObject: async () => "https://example.com/x",
      getObject: async () => null,
      exists: async () => false,
    };
    const sdk = OriginalsSDK.create({ storageAdapter: newStyleAdapter });
    expect((sdk as unknown as { config: { storageAdapter?: unknown } }).config.storageAdapter).toBe(newStyleAdapter);
  });
});
