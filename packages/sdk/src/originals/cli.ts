#!/usr/bin/env node
/**
 * `originals`: verify or inspect an evidence package offline. It needs no key
 * and makes no network request.
 *
 *   originals verify <package.zip> [--json] [--now <ISO time>] [--freshness asserted]
 *   originals inspect <package.zip>
 *
 * `verify` exits 0 when history, author binding, identity evidence and every
 * resource version verify; 1 otherwise; 2 for a usage error.
 */
import { readFileSync } from "node:fs";
import { OriginalsError } from "@originals/vh";
import { MemoryStore, OriginalsSDK, readEvidence } from "./index.js";

const USAGE = "usage: originals verify <package.zip> [--json] [--now <ISO time>] [--freshness asserted]\n       originals inspect <package.zip>\n";

async function main(argv: string[]): Promise<number> {
  const [command, file, ...rest] = argv;
  if ((command !== "verify" && command !== "inspect") || !file) {
    process.stderr.write(USAGE);
    return 2;
  }
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  let zip: Uint8Array;
  try {
    zip = new Uint8Array(readFileSync(file));
  } catch (error) {
    process.stderr.write(`cannot read ${file}: ${(error as Error).message}\n`);
    return 2;
  }
  try {
    if (command === "inspect") {
      process.stdout.write(`${JSON.stringify(readEvidence(zip).manifest, null, 2)}\n`);
      return 0;
    }
    const now = flag("--now");
    const at = now === undefined ? Date.now() : Date.parse(now);
    if (Number.isNaN(at)) {
      process.stderr.write(USAGE);
      return 2;
    }
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: () => at, ...(flag("--freshness") === "asserted" ? { freshness: "asserted" as const } : {}) });
    const { manifest, report, reasons } = await sdk.load(zip);
    const verified = report.history.status === "valid" && report.authorBinding.status === "valid" &&
      // Missing bytes are unavailable content, not a failure (P7.3, P7.4); served bytes must match.
      report.identityEvidence.status === "complete" && report.resources.status !== "digest-failure" &&
      !reasons.some((r) => r.startsWith("manifest-"));
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ...report, reasons, manifest, verified })}\n`);
    } else {
      process.stdout.write(`${verified ? "verified" : "not verified"}: ${report.original ?? "unknown Original"} at ${report.checkpoint ?? "no checkpoint"}\n`);
      for (const v of report.resources.versions) process.stdout.write(`  ${v.resource} v${v.version} ${v.digest} ${v.bytes}\n`);
      if (reasons.length > 0) process.stdout.write(`  not current: ${reasons.join(", ")}\n`);
    }
    return verified ? 0 : 1;
  } catch (error) {
    if (!(error instanceof OriginalsError)) throw error;
    if (rest.includes("--json")) process.stdout.write(`${JSON.stringify({ verified: false, error: { category: error.category, code: error.code, message: error.message } })}\n`);
    else process.stdout.write(`not verified: ${error.code}: ${error.message}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(2);
});
