/**
 * The diagrams in docs/diagrams/ are drawn by scripts/diagrams.ts. They must
 * be up to date, every API name they draw must still exist, and every report
 * part they draw must still be reported.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIAGRAM_DIR, diagrams } from "../../../scripts/diagrams.ts";
import * as root from "../../../src/index.js";
import * as bitcoin from "../../../src/originals/bitcoin-writer.js";
import { bytes, clock } from "./helpers.js";

const drawn = diagrams();
const all = Object.values(drawn).join("\n");
const attr = (name: string) => [...new Set([...all.matchAll(new RegExp(`${name}="([^"]+)"`, "g"))].map((m) => m[1]))];

/** `root:name`, `bitcoin:name`, `Class.static` or `Class#method`: does it still exist? */
function exists(ref: string): boolean {
  const exports = root as unknown as Record<string, unknown>;
  if (ref.startsWith("root:")) return exports[ref.slice(5)] !== undefined;
  if (ref.startsWith("bitcoin:")) return typeof (bitcoin as unknown as Record<string, unknown>)[ref.slice(8)] === "function";
  const [cls, member, kind] = ref.includes("#") ? [...ref.split("#"), "method"] : [...ref.split("."), "static"];
  const value = exports[cls] as { prototype?: Record<string, unknown> } & Record<string, unknown> | undefined;
  if (typeof value !== "function") return false;
  return typeof (kind === "method" ? value.prototype?.[member] : value[member]) === "function";
}

describe("SDK diagrams", () => {
  test("the SVGs in docs/diagrams match scripts/diagrams.ts (run `bun scripts/diagrams.ts`)", () => {
    for (const [name, svg] of Object.entries(drawn)) {
      expect(readFileSync(join(DIAGRAM_DIR, name), "utf8"), name).toBe(svg);
    }
  });

  test("each SVG is plain SVG with a title and description, and follows dark mode", () => {
    for (const [name, svg] of Object.entries(drawn)) {
      expect(svg, name).toContain("<title id=\"title\">");
      expect(svg, name).toContain("<desc id=\"desc\">");
      expect(svg, name).toContain("prefers-color-scheme: dark");
      expect(svg, name).not.toContain("foreignObject");
      expect(svg, name).not.toContain("<script");
    }
  });

  test("every API name drawn is still exported", () => {
    const refs = attr("data-api");
    expect(refs.length).toBeGreaterThan(20);
    expect(refs.filter((r) => !exists(r))).toEqual([]);
    // The check itself catches a renamed or removed name.
    for (const missing of ["OriginalsSDK#noSuchMethod", "OriginalsSDK.noSuch", "root:noSuch", "bitcoin:noSuch", "NoSuchClass#edit"]) {
      expect(exists(missing), missing).toBe(false);
    }
  });

  test("every report part drawn is still in a report", async () => {
    const start = Date.parse("2026-10-18T12:00:00Z");
    const author = await root.createLocalAuthor(start);
    const sdk = root.OriginalsSDK.create({ authors: [author.evidence], clock: clock(start) });
    const created = await sdk.create({ name: "x", resource: { mediaType: "text/plain", bytes: bytes("x") }, author: author.ref, signer: author.signer });
    if (created.kind !== "original") throw new Error("unreachable");
    const { report } = await root.OriginalsSDK.create({ authors: [] }).load((await sdk.package(created.original.did)).bytes);
    const parts = attr("data-report");
    expect(parts.length).toBe(9);
    expect(parts.filter((p) => !(p in report))).toEqual([]);
  });
});
