/**
 * Shows the verifier is not rubber-stamping the kit: two altered copies of the PNG package must
 * not verify. Offline; reads only the kit's files. Run from the repository root:
 *   bun handoff/did-og-png-mp4-kit/negative-checks.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPackageZip, verifyOriginal, writePackageZip } from "../../packages/vh/src/og/index.js";

const K = import.meta.dir;
const kit = JSON.parse(readFileSync(join(K, "kit.json"), "utf8")) as Record<string, { zip: string; original: string }>;
const files = readPackageZip(new Uint8Array(readFileSync(join(K, kit.png.zip))));
let ok = true;

// 1. One bit of the PNG flipped: the resource no longer matches the signed digest. The signed
//    history is still intact, so `outcome` can stay `verified`; the bad bytes are reported
//    separately, as `availability` and a `resource-mismatch` diagnostic (P7.3, P7.4). A consumer
//    must check `availability`, not `outcome` alone.
const res = Object.keys(files).find((n) => n.startsWith("resources/"))!;
const bad = new Uint8Array(files[res]);
bad[5000] ^= 1;
const r1 = await verifyOriginal({ original: kit.png.original, inputs: [{ kind: "package", source: "tampered-resource", bytes: writePackageZip({ ...files, [res]: bad }) }] });
console.log(`one PNG bit flipped -> ${JSON.stringify(r1.axes)} diagnostics: ${r1.diagnostics.map((d) => d.code).join(",") || "none"}`);
if ((r1.axes as { outcome: string }).outcome === "verified" && (r1.axes as { availability: string }).availability === "complete") ok = false;

// 2. The author's assertion key swapped in the packaged did:webvh log: the signer binding must fail.
const signer = Object.keys(files).find((n) => n.startsWith("signers/"))!;
const forged = new TextDecoder().decode(files[signer]).replace(/"publicKeyMultibase":"z6Mk[^"]+"/, '"publicKeyMultibase":"z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"');
const r2 = await verifyOriginal({ original: kit.png.original, inputs: [{ kind: "package", source: "forged-author", bytes: writePackageZip({ ...files, [signer]: new TextEncoder().encode(forged) }) }] });
console.log(`author key swapped in did:webvh log -> ${JSON.stringify(r2.axes)} diagnostics: ${r2.diagnostics.map((d) => d.code).join(",") || "none"}`);
if ((r2.axes as { outcome: string }).outcome === "verified") ok = false;

console.log(`\nRESULT: ${ok ? "PASS (neither altered package passes: the flipped bit is availability none with resource-mismatch; the forged key is identity incomplete)" : "FAIL (an altered package passed)"}`);
process.exit(ok ? 0 : 1);
