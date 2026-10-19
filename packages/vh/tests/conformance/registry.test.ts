import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Keeps specs/originals-conformance.json honest: a section 12 row is cited by
 * a test (as C12-NN) exactly when its status says it is partly or fully covered.
 */
interface Row { id: string; test: string; phases: number[]; status: "todo" | "partial" | "covered"; coveredBy?: string[] }
const registry = JSON.parse(readFileSync(new URL("../../../../specs/originals-conformance.json", import.meta.url), "utf8")) as { rows: Row[] };

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return d.name === "fixtures" ? [] : testFiles(path);
    return d.name.endsWith(".test.ts") ? [path] : [];
  });
}

// Test roots that may cite rows, relative to the repository root.
const repo = new URL("../../../../", import.meta.url).pathname;
const roots = ["packages/vh/tests", "packages/sdk/tests/unit/originals"];
const cited = new Map<string, Set<string>>();
for (const root of roots) {
  for (const file of testFiles(join(repo, root))) {
    if (file.endsWith("registry.test.ts")) continue;
    for (const [id] of readFileSync(file, "utf8").matchAll(/C12-\d{2}/g)) {
      const files = cited.get(id) ?? new Set<string>();
      files.add(file.slice(repo.length));
      cited.set(id, files);
    }
  }
}

describe("section 12 conformance registry", () => {
  test("registers all 93 rows with unique ids", () => {
    expect(registry.rows.length).toBe(93);
    expect(new Set(registry.rows.map((r) => r.id)).size).toBe(93);
  });

  test("every cited row exists and is marked partial or covered, with the citing files", () => {
    const byId = new Map(registry.rows.map((r) => [r.id, r]));
    for (const [id, files] of cited) {
      const row = byId.get(id);
      expect(row, `${id} is not a registered row`).toBeDefined();
      expect(row!.status, `${id} is cited but still todo`).not.toBe("todo");
      expect(new Set(row!.coveredBy ?? []), `${id} coveredBy`).toEqual(files);
    }
  });

  test("no row claims coverage without a citing test", () => {
    for (const row of registry.rows) {
      if (row.status !== "todo") expect(cited.has(row.id), `${row.id} claims ${row.status}`).toBe(true);
    }
  });
});
