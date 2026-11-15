/**
 * Leak guard: EVM anchoring (originals-spec PR 59) is built and tested but not
 * released until the spec pins an audited anchor contract (P14.21; owner
 * decision, 14 November 2026). No published entry point of `@originals/vh`
 * exports an EVM name or honours an anchor contract pin; an Original with an
 * `anchor` member is unsupported, never invalid (section 14), and the
 * builders refuse to write one. The EVM tests use the internal entry
 * (`src/originals/evm-internal.ts`, `@originals/vh/internal/evm` under the
 * private `originals-internal` condition).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as internal from "../src/originals/evm-internal.js";
import * as evm from "../src/originals/evm.js";
import * as evmAnchor from "../src/originals/evm-anchor.js";
import * as didEvm from "../src/originals/did-evm.js";
import { OPERATOR_CHAIN } from "./helpers/evm-chains.js";
import { VhAuthor, clock, describedBytes, photo, seeded } from "./helpers/originals.js";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, unknown> };
const PIN: internal.EvmAnchorPin = { address: "0x" + "ab".repeat(20), codeHash: "0x" + "00".repeat(32), chains: [...internal.EVM_CHAINS, OPERATOR_CHAIN] };
const MINTER = "0x" + "11".repeat(20);
const NOW = Date.UTC(2026, 10, 14);

/** Every published entry point: an export-map key a consumer resolves without a private condition. */
function published(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (key === "./package.json" || typeof value !== "object" || value === null) continue;
    const target = (value as { import?: string; default?: string }).import ?? (value as { default?: string }).default;
    if (target) out.push([key, target]);
  }
  return out;
}

/** The runtime names only the EVM modules define. */
const EVM_NAMES = new Set([...Object.keys(evm), ...Object.keys(evmAnchor), ...Object.keys(didEvm)]);

describe("published entry points expose no EVM anchoring (P14.21)", () => {
  test("the export map resolves the EVM entry only under the private condition", () => {
    expect(published().map(([k]) => k)).not.toContain("./internal/evm");
    expect(Object.keys(pkg.exports["./internal/evm"] as object)).toEqual(["originals-internal"]);
    for (const [, target] of published()) expect(target).not.toMatch(/evm/i);
  });

  for (const [key, target] of published()) {
    test(`${key} exports no EVM name`, async () => {
      const mod = (await import(join(ROOT, target.replace("./dist/", "./src/").replace(/\.js$/, ".ts")))) as Record<string, unknown>;
      const keys = Object.keys(mod);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((k) => /evm/i.test(k))).toEqual([]);
      expect(keys.filter((k) => EVM_NAMES.has(k))).toEqual([]);
    });
  }

  test("the internal entry still has them", () => {
    for (const name of ["EVM_CHAINS", "derivedTokenAlias", "isMoveEntry", "assembleFromEvm", "resolveDidEvm", "tokenIdOf", "parseEvmAlias"]) expect(internal).toHaveProperty(name);
  });
});

describe("published entry points take no anchor contract pin (section 14, P14.21)", async () => {
  const pub = await import("../src/originals/index.js");
  const key = seeded(77);
  const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
  const at = clock();
  const sign = alice.signer(key, "orig");
  const author = alice.ref("orig");
  const resource = photo("harbor");
  const anchor = { chain: OPERATOR_CHAIN.chain, minter: MINTER };

  test("a writer refuses an anchor member, even when handed a pin", async () => {
    const input = { versionTime: at(), name: "Harbor", resource, author, sign, anchor, evm: PIN } as Parameters<typeof pub.createOriginal>[0];
    await expect(pub.createOriginal(input)).rejects.toMatchObject({ category: "unsupported-profile", code: "EVM_NO_ANCHOR_CONTRACT" });
    expect(() => pub.prepareCreateOriginal(input)).toThrow(/P14.21/);
  });

  test("an Original whose genesis has an anchor member verifies as unsupported, with no EVM section", async () => {
    const genesis = await internal.createOriginal({ versionTime: at(), name: "Harbor", resource, author, sign, anchor, evm: PIN });
    const options = { log: [genesis], authors: [alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [] } } as Parameters<typeof pub.verifyOriginal>[0];
    const report = await pub.verifyOriginal(options);
    expect(report.history.status).toBe("unsupported");
    expect(report.history.failure).toMatchObject({ category: "unsupported-profile", code: "EVM_NO_ANCHOR_CONTRACT" });
    expect(report.reasons).toContain("unsupported-profile");
    expect(report.current).toBe(false);
    expect(report).not.toHaveProperty("evm");
    // The internal verifier, given the same pin, gets past support.
    const full = await internal.verifyOriginal({ log: [genesis], authors: [alice.evidence()], now: NOW, evm: { pin: PIN, tokens: [] } });
    expect(full.evm).not.toBeNull();
    expect(full.history.failure?.code).not.toBe("EVM_NO_ANCHOR_CONTRACT");
  });

  test("a carried log with an anchor member reads as unsupported", async () => {
    const genesis = await internal.createOriginal({ versionTime: at(), name: "Harbor", resource, author, sign, anchor, evm: PIN });
    const file = await pub.writeCarriedFile(describedBytes(resource.digest)!, [genesis], { disclosed: pub.carriedDisclosure([genesis]) });
    const options = { evm: { pin: PIN, tokens: [] }, now: NOW } as Parameters<typeof pub.readCarriedFile>[1];
    const read = await pub.readCarriedFile(file, options);
    expect(read.overall.status).toBe("unsupported");
    expect(read.report ?? {}).not.toHaveProperty("evm");
  });
});
