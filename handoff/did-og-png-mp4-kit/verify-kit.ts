/**
 * Verifies the kit offline with the SDK's own did:og verifier (`verifyOriginal`,
 * `@originals/vh/og`). Each Original's evidence set is exactly one input, its ZIP read from disk
 * (kind `package`). Nothing else is supplied and nothing is fetched: `fetch` is replaced by a
 * tripwire that throws, and the run is meant to happen with networking denied (see README.md).
 *
 * Also checked, before the verifier runs:
 * - each ZIP's SHA-256 against `<zip>.sha256`, and each member against `<zip>.contents.sha256`;
 * - each ZIP holds only the members P14.10 defines, and is in the writer's canonical byte form;
 * - the packaged resource is byte for byte the file in `media/`.
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
const P14_10_MEMBER = /^(originals-evidence\.json|asset\/did\.jsonl|signers\/[0-9a-f]{64}\/did\.jsonl|signers\/[0-9a-f]{64}\/did-witness\.json|resources\/z[1-9A-HJ-NP-Za-km-z]+)$/;

let fetches = 0;
globalThis.fetch = (async (input: unknown) => {
  fetches++;
  throw new Error(`network access attempted during offline verification: ${String(input)}`);
}) as typeof fetch;

type KitEntry = { zip: string; original: string; resource: { file: string; digest: string } };
const kit = JSON.parse(readFileSync(join(KIT, "kit.json"), "utf8")) as Record<string, KitEntry>;
let ok = true;
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) ok = false;
};

for (const slug of ["png", "mp4"]) {
  const { zip, original, resource } = kit[slug];
  console.log(`\n=== ${slug}: ${zip} ===`);
  const archive = new Uint8Array(readFileSync(join(KIT, zip)));
  const stated = readFileSync(join(KIT, `${zip}.sha256`), "utf8").split(/\s+/)[0];
  check(sha256(archive) === stated, `${sha256(archive)}  ${zip} (matches ${zip}.sha256)`);

  const files = readPackageZip(archive);
  const names = Object.keys(files);
  const sums = readFileSync(join(KIT, `${zip}.contents.sha256`), "utf8").trimEnd().split("\n").map((l) => l.split("  ") as [string, string]);
  check(sums.length === names.length && names.every((n) => sums.some(([, s]) => s === n)), `${zip}.contents.sha256 lists every member (${names.length}) and nothing else`);
  for (const [hex, name] of sums) check(files[name] !== undefined && sha256(files[name]) === hex, `${hex}  ${name}`);
  check(names.every((n) => P14_10_MEMBER.test(n)), `only P14.10 members: ${names.join(", ")}`);
  check(Buffer.compare(Buffer.from(writePackageZip(files)), Buffer.from(archive)) === 0, "the ZIP is in the canonical P14.10 byte form (rewriting its members gives the same bytes)");
  const media = new Uint8Array(readFileSync(join(KIT, resource.file)));
  check(Buffer.compare(Buffer.from(files[`resources/${resource.digest}`]), Buffer.from(media)) === 0, `resources/${resource.digest} is byte for byte ${resource.file}`);

  const report = await verifyOriginal({ original, inputs: [{ kind: "package", source: `file:${zip}`, bytes: archive }] });
  console.log(`--- report (verifyOriginal, evidence set = this ZIP only) ---\n${JSON.stringify(report, null, 2)}`);
  const axes = report.axes as Record<string, string>;
  check(axes.outcome === "verified", `outcome ${axes.outcome}`);
  check(axes.binding === "bound", `binding ${axes.binding}`);
  check(axes.history === "valid", `history ${axes.history}`);
  check(axes.identity === "complete", `identity ${axes.identity} (author did:webvh history checked from the package)`);
  check(axes.availability === "complete", `availability ${axes.availability} (the resource bytes are in the package and match)`);
  check(axes.offline === "self-contained", `offline ${axes.offline}`);
  // P7.18: an Original that is not anchored is `valid-as-of` its checkpoint, never `current`.
  check(axes.state === "valid-as-of", `state ${axes.state} (unanchored: valid as of ${report.checkpoint})`);
  // P7.18: `not-read` is "the evidence set has no Bitcoin input and nothing in the log names an anchor".
  check(axes.bitcoin === "not-read", `bitcoin ${axes.bitcoin} (no Bitcoin input, no anchor named: P7.18)`);
  check(report.entries.length > 0 && report.entries.every((e) => e.status === "accepted"), `every entry accepted (${report.entries.length})`);
  check(report.diagnostics.length === 0, `no diagnostics (${report.diagnostics.length})`);
}

check(fetches === 0, `network requests attempted: ${fetches}`);
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
