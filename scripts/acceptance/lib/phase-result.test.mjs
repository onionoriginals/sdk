import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPhaseResult } from "./phase-result.mjs";

for (const scenario of ["killed before result", "timeout before result", "crashed after PASS"]) {
  test(scenario + " preserves a FAIL artifact for the receipt", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase-result-test-"));
    try {
      const resultFile = join(dir, "phase.json");
      if (scenario === "crashed after PASS") {
        writeFileSync(resultFile, JSON.stringify({ status: "PASS", checks: [{ id: "done", status: "PASS" }] }));
      }
      const source = scenario === "killed before result"
        ? 'process.kill(process.pid, "SIGTERM")'
        : scenario === "timeout before result" ? 'setInterval(() => {}, 1000)' : 'process.exit(1)';
      const run = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", timeout: 2000 });
      assert.notEqual(run.status, 0);
      const result = recordPhaseResult({ name: "S1-client-a", resultFile, run, command: [process.execPath], root: dir, ms: 1 });
      assert.equal(result.status, "FAIL");
      assert.equal(JSON.parse(readFileSync(resultFile, "utf8")).status, "FAIL");
      assert.ok(result.checks.some(check => check.status === "FAIL"));
      assert.equal(result.process.exit, run.status);
      assert.equal(result.process.signal, run.signal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
