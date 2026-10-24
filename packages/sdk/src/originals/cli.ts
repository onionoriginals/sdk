#!/usr/bin/env node
/**
 * `originals`: verify or inspect an evidence package offline. It needs no key
 * and makes no network request.
 *
 *   originals verify <package.zip> [--json] [--now <ISO time>]
 *   originals inspect <package.zip>
 *
 * `verify` exits 0 when history, author binding, identity evidence and every
 * resource version verify; 1 otherwise; 2 for a usage error. A verified
 * unanchored Original is reported valid as of its checkpoint, with the signer
 * DID versions relied on and when they were obtained (the package's, at
 * verification time); it is never current (P7.10). For each signer DID it
 * says where and when its history was obtained and, unless freshness is
 * established, that the DID may have a newer version the verifier has not
 * seen (P7.8). Entries historically authorized only are listed (P7.9).
 */
import { readFileSync } from "node:fs";
import { OriginalsError } from "@originals/vh";
import { describeFreshness } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, readEvidence } from "./index.js";

const USAGE = "usage: originals verify <package.zip> [--json] [--now <ISO time>]\n       originals inspect <package.zip>\n";

async function main(argv: string[]): Promise<number> {
  const [command, file, ...rest] = argv;
  // `--freshness asserted` is gone: no freshness policy makes an unanchored Original current (P7.10).
  if ((command !== "verify" && command !== "inspect") || !file || rest.includes("--freshness")) {
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
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: () => at });
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
      if (report.validAsOf) {
        process.stdout.write(`  valid as of ${report.validAsOf.checkpoint}, not current: not anchored (P7.10)\n`);
        for (const s of report.validAsOf.signers) process.stdout.write(`  ${s.role} ${s.did} at ${s.versionId ?? "no version"}, obtained ${s.obtainedAt ?? "at an unknown time"} from ${s.source ?? "an unknown source"}\n`);
      }
      // P7.8: plainly, where and when each signer DID's history was obtained, and whether it may be newer.
      const author = report.identityEvidence.author;
      if (author) process.stdout.write(`  ${describeFreshness(author, report.identityEvidence)}\n`);
      for (const e of report.identityEvidence.editors) process.stdout.write(`  ${describeFreshness(e.did, e)}\n`);
      for (const h of report.historicallyAuthorizedOnly) process.stdout.write(`  ${h.versionId}: historically authorized only (${h.reason}, P7.9)\n`);
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
