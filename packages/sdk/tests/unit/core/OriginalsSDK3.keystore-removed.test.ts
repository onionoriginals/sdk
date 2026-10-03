import { describe, expect, test } from "bun:test";
import { OriginalsSDK } from "../../../src/core/OriginalsSDK3";
import { CelError } from "@originals/cel/v3";
import { MockKeyStore } from "../../mocks/MockKeyStore";

describe("OriginalsSDK rejects the removed keyStore option", () => {
  test("constructor throws SDK_OPTION_REMOVED when keyStore is passed", () => {
    let thrown: unknown;
    try {
      OriginalsSDK.create({ keyStore: new MockKeyStore() } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CelError);
    expect((thrown as CelError).code).toBe("SDK_OPTION_REMOVED");
    expect((thrown as CelError).message).toContain("keyStore");
  });

  test("an explicit undefined keyStore is still rejected (the key is the contract)", () => {
    expect(() => OriginalsSDK.create({ keyStore: undefined } as never)).toThrow(
      /keyStore was removed/,
    );
  });

  test("the same options without keyStore construct normally", () => {
    const sdk = OriginalsSDK.create({ defaultKeyType: "Ed25519" });
    expect(sdk.did).toBeDefined();
    expect(sdk.credentials).toBeDefined();
  });
});
