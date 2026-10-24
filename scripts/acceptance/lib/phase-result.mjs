import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

/** Preserve a child phase outcome even when it exits before Phase.finish(). */
export function recordPhaseResult({ name, resultFile, run, command, root, ms }) {
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : { phase: name, status: "FAIL", checks: [{ id: "result", title: "the phase wrote a result", status: "FAIL" }] };
  result.phase = name;
  result.process = { command: command.map((a) => (a.startsWith(root) ? relative(root, a) : a)), exit: run.status, signal: run.signal, ms };
  if (run.status !== 0) {
    result.status = "FAIL";
    result.checks.push({ id: "process", title: "the phase process exited successfully", status: "FAIL" });
  }
  if (run.status !== 0 || result.status !== "PASS") result.process.output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim().split("\n").filter((l) => !l.startsWith("[originals-sdk]")).slice(-40);
  // A killed or timed-out child never reaches Phase.finish(). Persist the
  // fallback too, so receipt artifact hashing can always read this outcome.
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
