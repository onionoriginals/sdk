/**
 * Verifies the kit offline with the SDK's own did:og verifier (`verifyOriginal`,
 * `@originals/vh/og`). Each Original's evidence set is exactly one input, its ZIP read from disk
 * (kind `package`). Nothing else is supplied and nothing is fetched: `fetch` is replaced by a
 * tripwire that throws, and the run is meant to happen under `sandbox-exec` with networking denied
 * (see README.md).
 *
 * Also checked: each ZIP's SHA-256 against its `.sha256` file; every member against the
 * SHA256SUMS inside the ZIP; and that the report does not depend on SHA256SUMS (the same package
 * without it gives the same report).
 *
 * Exit 0 only if every check passes. Run from the repository root:
 *   bun handoff/did-og-png-mp4-kit/verify-kit.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPackageZip, verifyOriginal, writePackageZip } from "../../packages/vh/src/og/index.js";

const KIT = import.meta.dir;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const dec = new TextDecoder();

let fetches = 0;
globalThis.fetch = (async (input: unknown) => {
  fetches++;
  throw new Error(`network access attempted during offline verification: ${String(input)}`);
}) as typeof fetch;

const kit = JSON.parse(readFileSync(join(KIT, "kit.json"), "utf8")) as Record<string, { zip: string; original: string }>;
let ok = true;
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) ok = false;
};

for (const slug of ["png", "mp4"]) {
  const { zip, original } = kit[slug];
  console.log(`\n=== ${slug}: ${zip} ===`);
  const archive = new Uint8Array(readFileSync(join(KIT, zip)));
  const stated = readFileSync(join(KIT, `${zip}.sha256`), "utf8").split(/\s+/)[0];
  check(sha256(archive) === stated, `ZIP SHA-256 ${sha256(archive)} matches ${zip}.sha256`);

  const files = readPackageZip(archive);
  const sums = dec.decode(files.SHA256SUMS).trimEnd().split("\n").map((l) => l.split("  ") as [string, string]);
  const members = Object.keys(files).filter((n) => n !== "SHA256SUMS");
  check(sums.length === members.length && members.every((m) => sums.some(([, n]) => n === m)), `SHA256SUMS lists every member (${members.length}) and nothing else`);
  for (const [hex, name] of sums) check(files[name] !== undefined && sha256(files[name]) === hex, `${hex}  ${name}`);

  const report = await verifyOriginal({ original, inputs: [{ kind: "package", source: `file:${zip}`, bytes: archive }] });
  console.log(`--- report (verifyOriginal, evidence set = this ZIP only) ---\n${JSON.stringify(report, null, 2)}`);
  const axes = report.axes as Record<string, string>;
  check(axes.outcome === "verified", `outcome ${axes.outcome}`);
  check(axes.binding === "bound", `binding ${axes.binding}`);
  check(axes.history === "valid", `history ${axes.history}`);
  check(axes.identity === "complete", `identity ${axes.identity} (author did:webvh history checked from the package)`);
  check(axes.availability === "complete", `availability ${axes.availability} (the resource bytes are in the package)`);
  check(axes.offline === "self-contained", `offline ${axes.offline}`);
  // P7.18: `not-read` is "the evidence set has no Bitcoin input and nothing in the log names an
  // anchor" (`not-anchored` would need Bitcoin to have been read). This kit is not anchored.
  check(axes.bitcoin === "not-read", `bitcoin ${axes.bitcoin} (no Bitcoin input, no anchor named: P7.18)`);
  // P7.18: an Original that is not anchored is `valid-as-of` its checkpoint, never `current`.
  check(axes.state === "valid-as-of", `state ${axes.state} (unanchored: valid as of ${report.checkpoint})`);
  check(report.entries.every((e) => e.status === "accepted"), `every entry accepted (${report.entries.length})`);
  check(report.diagnostics.length === 0, `no diagnostics (${report.diagnostics.length})`);

  // SHA256SUMS is not part of P14.10's member list; the report must not depend on it.
  const { SHA256SUMS: _sums, ...plain } = files;
  const without = await verifyOriginal({ original, inputs: [{ kind: "package", source: `file:${zip}`, bytes: writePackageZip(plain) }] });
  check(JSON.stringify(without.axes) === JSON.stringify(report.axes) && JSON.stringify(without.entries) === JSON.stringify(report.entries), "same axes and entries without SHA256SUMS");
}

check(fetches === 0, `network requests attempted: ${fetches}`);
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
