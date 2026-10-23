/**
 * Shared helpers for one acceptance phase: its input, PASS/FAIL checks, the
 * isolation facts it reports, the network probe and the private-key scan.
 * Every phase is a separate OS process started by ../local-release.mjs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { base58btcEncode } from "@originals/vh/crypto";

export function phaseInput() {
  const raw = process.env.ACCEPTANCE_INPUT;
  if (!raw) throw new Error("ACCEPTANCE_INPUT is not set; run this phase through scripts/acceptance/local-release.mjs");
  return JSON.parse(raw);
}

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const utf8 = (text) => new TextEncoder().encode(text);
export const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));

export class CheckFailed extends Error {}

export function assert(condition, message, detail) {
  if (!condition) throw new CheckFailed(`${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new CheckFailed(`${message}: expected ${e}, got ${a}`);
}

/** Await a rejection and return it; anything else fails the check. */
export async function rejection(promise, message) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new CheckFailed(`${message}: expected a rejection, but it resolved`);
}

/** An OriginalsError, described for the receipt. */
export function describeError(error) {
  return { name: error?.name, category: error?.category, code: error?.code, message: String(error?.message ?? error).slice(0, 300) };
}

export class Phase {
  constructor(name) {
    this.name = name;
    this.input = phaseInput();
    this.checks = [];
    this.facts = {};
    this.started = new Date().toISOString();
  }

  /** Run one named check. `fn` returns the detail recorded with a PASS; any throw is a FAIL. */
  async check(id, title, fn) {
    try {
      const detail = await fn();
      this.checks.push({ id, title, status: "PASS", ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      this.checks.push({ id, title, status: "FAIL", error: error instanceof CheckFailed ? error.message : `${error?.name}: ${error?.message}`, ...(error instanceof CheckFailed ? {} : { stack: String(error?.stack ?? "").split("\n").slice(0, 6) }) });
    }
  }

  isolation() {
    return {
      pid: process.pid,
      ppid: process.ppid,
      runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
      execPath: process.execPath,
      cwd: process.cwd(),
      home: process.env.HOME,
      tmpdir: process.env.TMPDIR,
      envNames: Object.keys(process.env).sort(),
      dirs: this.input.dirs,
    };
  }

  /** Write the result file for the orchestrator and exit non-zero on any FAIL. */
  finish() {
    const failed = this.checks.filter((c) => c.status !== "PASS").length;
    const result = {
      phase: this.name,
      started: this.started,
      finished: new Date().toISOString(),
      isolation: this.isolation(),
      facts: this.facts,
      checks: this.checks,
      status: failed === 0 && this.checks.length > 0 ? "PASS" : "FAIL",
    };
    writeFileSync(process.env.ACCEPTANCE_RESULT, `${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "PASS" ? 0 : 1;
  }

  /**
   * Check both network layers. In process: fetch, sockets and DNS throw. OS
   * level: a child without the guard (same sandbox) cannot open a socket.
   */
  async probeNetwork() {
    await this.check("network-blocked", "network is disabled in this process (in-process guard and OS layer)", async () => {
      const guard = globalThis.__acceptanceNetworkGuard;
      assert(guard?.installed === true, "the in-process network guard is not installed");
      const net = await import("node:net");
      const dns = await import("node:dns");
      const outcomes = {};
      try {
        await fetch("https://example.com/");
        outcomes.fetch = "CONNECTED";
      } catch (error) {
        outcomes.fetch = error.code ?? error.name;
      }
      try {
        net.connect(443, "1.1.1.1");
        outcomes.netConnect = "CONNECTED";
      } catch (error) {
        outcomes.netConnect = error.code ?? error.name;
      }
      try {
        await dns.promises.lookup("example.com");
        outcomes.dnsLookup = "RESOLVED";
      } catch (error) {
        outcomes.dnsLookup = error.code ?? error.name;
      }
      for (const [k, v] of Object.entries(outcomes)) assert(v === "ACCEPTANCE_NETWORK_BLOCKED", `in-process ${k} was not blocked`, v);

      const os = this.input.osNetworkBlock;
      const probe = `const s=require("node:net").connect(443,"1.1.1.1");s.setTimeout(4000);` +
        `s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});` +
        `s.on("timeout",()=>{console.log("TIMEOUT");process.exit(0)});` +
        `s.on("error",e=>{console.log(e.code||e.message);process.exit(0)});`;
      // Node reports the OS refusal precisely (Bun maps a sandbox EPERM to ECONNREFUSED), so the probe always runs on Node.
      const child = spawnSync(this.input.probeNode ?? process.execPath, ["-e", probe], { encoding: "utf8", timeout: 10_000, env: process.env });
      const osOutcome = (child.stdout || child.stderr || String(child.error)).trim();
      if (os !== "none") assert(["EPERM", "EACCES", "ENETUNREACH", "EHOSTUNREACH"].includes(osOutcome), `OS layer (${os}) did not refuse a raw socket`, osOutcome);
      this.facts.network = { inProcess: outcomes, osLayer: os, osProbe: osOutcome, guardAttempts: guard.attempts.length };
      return this.facts.network;
    });
  }
}

/** Every encoding of a 32-byte secret that could plausibly appear in a file. */
export function secretEncodings(secret) {
  const b = Buffer.from(secret);
  const hex = b.toString("hex");
  return {
    raw: b,
    hex: Buffer.from(hex),
    HEX: Buffer.from(hex.toUpperCase()),
    base64: Buffer.from(b.toString("base64").replace(/=+$/, "")),
    base64url: Buffer.from(b.toString("base64url")),
    base58btc: Buffer.from(base58btcEncode(secret)),
    // Multikey form of an Ed25519 private key (multicodec 0x8026).
    multikey: Buffer.from(base58btcEncode(Uint8Array.from([0x80, 0x26, ...secret]))),
    jsonArray: Buffer.from(JSON.stringify([...secret])),
  };
}

/** Where any encoding of any secret appears in `bytes`. */
export function findSecrets(bytes, secrets) {
  const hay = Buffer.from(bytes);
  const hits = [];
  for (const [label, secret] of Object.entries(secrets)) {
    for (const [encoding, needle] of Object.entries(secretEncodings(secret))) {
      if (hay.indexOf(needle) >= 0) hits.push(`${label}:${encoding}`);
    }
  }
  return hits;
}

/** Every regular file under a directory. */
export function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...filesUnder(path));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

export const readBytes = (path) => new Uint8Array(readFileSync(path));
