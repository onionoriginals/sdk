/**
 * Leak guard: EVM anchoring (originals-spec PR 59) is built and tested but not
 * released until the spec pins an audited anchor contract (P14.21; owner
 * decision, 14 November 2026). No published entry point of `@originals/sdk`
 * exports an EVM name, and the published `OriginalsSDK` ignores an `evm`
 * option: only the internal `createEvmOriginalsSDK` (src/originals/evm-runtime.ts)
 * enables it. The published declarations are checked by `verify:esm` and
 * `typecheck:public`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVM_CHAINS, type EvmAnchorPin } from "@originals/vh/internal/evm";
import * as evmAdapters from "../../../src/originals/evm.js";
import * as evmRuntime from "../../../src/originals/evm-runtime.js";
import { MemoryStore, OriginalsSDK } from "../../../src/originals/index.js";
import { Author, bytes, seed } from "./helpers.js";

const ROOT = join(import.meta.dir, "../../..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, unknown>; bin?: Record<string, string> };
const EVM_NAMES = new Set([...Object.keys(evmAdapters), ...Object.keys(evmRuntime)]);
const PIN: EvmAnchorPin = { address: "0x" + "ab".repeat(20), codeHash: "0x" + "00".repeat(32), chains: [...EVM_CHAINS] };
const BASE = { chain: "eip155:8453", minter: "0x" + "11".repeat(20) };

/** Every published entry point, by export-map key, with its built target. */
function published(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (key === "./package.json") continue;
    const target = typeof value === "string" ? value : ((value as { import?: string; default?: string }).import ?? (value as { default?: string }).default);
    if (target) out.push([key, target]);
  }
  return out;
}

describe("published entry points expose no EVM anchoring (P14.21)", () => {
  test("the export map has no EVM subpath, and the CLI is not one", () => {
    expect(Object.keys(pkg.exports)).not.toContain("./originals/evm");
    for (const [key, target] of published()) {
      expect(key).not.toMatch(/evm/i);
      expect(target).not.toMatch(/evm/i);
    }
    for (const bin of Object.values(pkg.bin ?? {})) expect(bin).not.toMatch(/evm/i);
  });

  for (const [key, target] of published()) {
    test(`${key} exports no EVM name`, async () => {
      const mod = (await import(join(ROOT, target.replace("./dist/", "./src/").replace(/\.js$/, ".ts")))) as Record<string, unknown>;
      const keys = Object.keys(mod);
      expect(keys.filter((k) => /evm/i.test(k))).toEqual([]);
      expect(keys.filter((k) => EVM_NAMES.has(k))).toEqual([]);
    });
  }

  test("the internal modules still have them", () => {
    for (const name of ["readEvmToken", "mintEvmToken", "prepareEvmPublication", "evmGenesisNotice", "EvmRpc"]) expect(evmAdapters).toHaveProperty(name);
    expect(evmRuntime).toHaveProperty("createEvmOriginalsSDK");
  });
});

describe("the published OriginalsSDK takes no EVM option (section 14, P14.21)", () => {
  test("an evm option without the internal runtime is ignored: create refuses an anchor member", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: seed(9) }]);
    const options = { store: new MemoryStore(), authors: [alice.evidence()], evm: { pin: PIN } } as Parameters<typeof OriginalsSDK.create>[0];
    const sdk = OriginalsSDK.create(options);
    const create = sdk.create({ name: "Harbor", resource: { mediaType: "text/plain", bytes: bytes("v1") }, author: alice.ref("orig"), signer: alice.signer("orig", seed(9)), anchor: BASE } as Parameters<typeof sdk.create>[0]);
    await expect(create).rejects.toMatchObject({ category: "unsupported-profile", code: "EVM_NO_ANCHOR_CONTRACT" });
    // The EVM methods are not on the published type and refuse at run time.
    const hidden = sdk as unknown as Record<string, (did: string, ...rest: unknown[]) => Promise<unknown>>;
    for (const method of ["mintEvm", "prepareEvmPublication", "submitEvmPublication", "evmPublicationStatus", "prepareMove", "move"]) {
      await expect(hidden[method]!("did:vh:example", {}, {})).rejects.toMatchObject({ category: "unsupported-profile", code: "EVM_NO_ANCHOR_CONTRACT" });
    }
  });
});
