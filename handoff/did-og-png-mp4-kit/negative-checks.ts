/**
 * Tamper tests: altered copies of each evidence package must FAIL the same pass criteria
 * `verify-kit.ts` applies, each with a clear reason. Offline; reads only the kit's files. The ZIPs
 * on disk are never modified: each tamper works on a copy in memory, rewritten with the SDK's own
 * ZIP writer.
 *
 * 1. media byte flipped: one byte of `resources/<digest>` changed;
 * 2. did:og log entry altered: the asset name in the genesis entry of `asset/did.jsonl` changed;
 * 3. DID log entry altered: the `versionTime` of the author's did:webvh log entry changed;
 * 4. signer history swapped: the author's did:webvh log replaced by another valid did:webvh log,
 *    of a different DID made for this test with throwaway keys (deleted afterwards).
 *
 * Exit 0 only if every tampered package fails. Run from the repository root:
 *   bun handoff/did-og-png-mp4-kit/negative-checks.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorDid } from "../../packages/sdk/src/og/index.js";
import { generateKeyFile } from "../../packages/sdk/src/og/keys.js";
import { readPackageZip, verifyOriginal, writePackageZip, type Report } from "../../packages/vh/src/og/index.js";

const KIT = import.meta.dir;
const enc = new TextEncoder();
const dec = new TextDecoder();
const kit = JSON.parse(readFileSync(join(KIT, "kit.json"), "utf8")) as Record<string, { zip: string; original: string }>;

/** What `verify-kit.ts` requires of a passing report. */
const EXPECTED: Record<string, string> = { outcome: "verified", binding: "bound", history: "valid", identity: "complete", availability: "complete", offline: "self-contained", state: "valid-as-of", bitcoin: "not-read" };

/** Why a report fails the pass criteria: each axis off its expected value, each diagnostic, each entry not accepted. */
function failures(r: Report): string[] {
  const axes = r.axes as Record<string, string>;
  const out = Object.entries(EXPECTED).filter(([k, v]) => axes[k] !== v).map(([k, v]) => `${k} ${axes[k] ?? "(absent)"} (expected ${v})`);
  for (const d of r.diagnostics) out.push(`diagnostic ${d.code} (rule ${d.rule})${d.reason ? `: ${d.reason}` : ""}`);
  for (const e of r.entries) if (e.status !== "accepted") out.push(`entry ${e.versionId} ${e.status}${"rule" in e && e.rule ? ` (rule ${e.rule})` : ""}${"reason" in e && e.reason ? `: ${e.reason}` : ""}`);
  if (r.entries.length === 0) out.push("no entry accepted");
  return out;
}

// A valid did:webvh log of a different DID, for the swap.
const secrets = mkdtempSync(join(tmpdir(), "og-handoff-tamper-"));
let other: { did: string; log: string };
try {
  other = await createAuthorDid(generateKeyFile(join(secrets, "keys.json")), { domain: "example.com", path: ["authors", "someone-else"] });
} finally {
  rmSync(secrets, { recursive: true, force: true });
}

const TAMPERS: Array<{ name: string; apply: (f: Record<string, Uint8Array>) => void }> = [
  {
    name: "1. media byte flipped",
    apply: (f) => {
      const k = Object.keys(f).find((n) => n.startsWith("resources/"))!;
      const b = new Uint8Array(f[k]);
      b[Math.floor(b.length / 2)] ^= 0xff;
      f[k] = b;
    },
  },
  {
    name: "2. did:og log entry altered (asset name in the genesis entry)",
    apply: (f) => {
      const text = dec.decode(f["asset/did.jsonl"]);
      const changed = text.replace(/"name":"([^"]*)"/, (_m, n: string) => `"name":"${n} (altered)"`);
      if (changed === text) throw new Error("no asset name to alter");
      f["asset/did.jsonl"] = enc.encode(changed);
    },
  },
  {
    name: "3. DID log entry altered (versionTime of the author's did:webvh entry)",
    apply: (f) => {
      const k = Object.keys(f).find((n) => n.startsWith("signers/") && n.endsWith("/did.jsonl"))!;
      const text = dec.decode(f[k]);
      const changed = text.replace(/"versionTime":"(\d{4})/, (_m, y: string) => `"versionTime":"${Number(y) - 1}`);
      if (changed === text) throw new Error("no versionTime to alter");
      f[k] = enc.encode(changed);
    },
  },
  {
    name: "4. signer history swapped (another valid did:webvh log, of a different DID)",
    apply: (f) => {
      const k = Object.keys(f).find((n) => n.startsWith("signers/") && n.endsWith("/did.jsonl"))!;
      f[k] = enc.encode(other.log);
    },
  },
];

let ok = true;
for (const slug of ["png", "mp4"]) {
  const { zip, original } = kit[slug];
  const pristine = readPackageZip(new Uint8Array(readFileSync(join(KIT, zip))));
  console.log(`\n=== ${slug}: ${zip} ===`);
  for (const t of TAMPERS) {
    const files = { ...pristine };
    t.apply(files);
    const r = await verifyOriginal({ original, inputs: [{ kind: "package", source: `tampered:${zip}`, bytes: writePackageZip(files) }] });
    const why = failures(r);
    console.log(`${why.length > 0 ? "FAIL (as expected)" : "PASSED (NOT expected)"}  ${t.name}`);
    for (const w of why) console.log(`      - ${w}`);
    console.log(`      axes: ${JSON.stringify(r.axes)}`);
    if (why.length === 0) ok = false;
  }
}
console.log(`\nswap source: ${other!.did}`);
console.log(`\nRESULT: ${ok ? "PASS (every tampered package fails, with the reasons above)" : "FAIL (a tampered package passed)"}`);
process.exit(ok ? 0 : 1);
