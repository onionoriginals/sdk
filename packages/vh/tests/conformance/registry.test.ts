import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Keeps specs/originals-conformance.json honest: a section 12 row is cited by
 * a test (as C12-NN) exactly when its status says it is partly or fully covered.
 * A row an owner decision makes moot is not-applicable, names the decision in
 * its note, and is cited by no test.
 */
interface Row { id: string; position: number; test: string; phases: number[]; status: "todo" | "partial" | "covered" | "not-applicable"; coveredBy?: string[]; note?: string; proposal?: string }
const registry = JSON.parse(readFileSync(new URL("../../../../specs/originals-conformance.json", import.meta.url), "utf8")) as {
  spec: { openProposals: Array<{ pr: number; head: string; rows: number[] }> };
  rows: Row[];
};

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
    for (const [id] of readFileSync(file, "utf8").matchAll(/\bC12-\d{2,3}\b/g)) {
      const files = cited.get(id) ?? new Set<string>();
      files.add(file.slice(repo.length));
      cited.set(id, files);
    }
  }
}

describe("section 12 conformance registry", () => {
  // The pinned table (originals-spec master 1039c471c) has 159 rows. Open spec PRs propose more,
  // registered provisionally with `proposal`: #50 row 160, and #51 rows 160 to 174. Ids are stable
  // across re-pins, so they need not equal table positions; a pinned row records its position in
  // the pinned table, a proposed one its position in its pull request's table.
  test("registers all 159 pinned rows and the proposed ones with unique ids, in table order", () => {
    expect(registry.rows.length).toBe(175);
    const pinned = registry.rows.filter((r) => r.proposal === undefined);
    expect(pinned.length).toBe(159);
    expect(registry.rows.slice(0, 159)).toEqual(pinned);
    expect(pinned.map((r) => r.position)).toEqual(pinned.map((_, i) => i + 1));
    expect(new Set(registry.rows.map((r) => r.id)).size).toBe(175);
    for (const r of registry.rows) expect(r.id).toMatch(/^C12-\d{2,3}$/);
  });

  test("each open proposal lists its rows, in its table's order after the pinned rows", () => {
    for (const p of registry.spec.openProposals) {
      const rows = registry.rows.filter((r) => r.proposal === `originals-spec#${p.pr}@${p.head}`);
      expect(rows.map((r) => r.position), `#${p.pr}`).toEqual(p.rows);
      expect(Math.min(...p.rows), `#${p.pr}`).toBeGreaterThan(159);
    }
    const listed = new Set(registry.spec.openProposals.map((p) => `originals-spec#${p.pr}@${p.head}`));
    for (const r of registry.rows.filter((r) => r.proposal !== undefined)) expect(listed.has(r.proposal!), r.id).toBe(true);
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
      if (row.status === "partial" || row.status === "covered") expect(cited.has(row.id), `${row.id} claims ${row.status}`).toBe(true);
    }
  });

  test("a row from an open spec pull request names it and is marked PROVISIONAL", () => {
    for (const row of registry.rows.filter((r) => r.proposal !== undefined)) {
      expect(row.proposal, row.id).toMatch(/^originals-spec#\d+@[0-9a-f]{9}$/);
      expect(row.note ?? "", `${row.id} note`).toMatch(/PROVISIONAL/);
    }
  });

  test("a not-applicable row names the owner decision and is cited by no test", () => {
    for (const row of registry.rows.filter((r) => r.status === "not-applicable")) {
      expect(row.note ?? "", `${row.id} note`).toMatch(/owner decision Q\d+/i);
      expect(cited.has(row.id), `${row.id} is not-applicable but cited`).toBe(false);
    }
  });
});
