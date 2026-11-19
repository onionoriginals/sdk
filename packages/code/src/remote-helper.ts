#!/usr/bin/env node
/**
 * `git-remote-originals` (plan 049 phase 5; PROVISIONAL K16): a git remote
 * helper (gitremote-helpers(7)), so that
 *
 *   git clone originals::<path, file:// or https:// URL of a repo bundle> <dir>
 *
 * clones a verified repo bundle. Before listing anything, the helper verifies
 * the whole bundle offline, with no key (P7.3); it lists only refs whose
 * canonical head is agreed and whose branch verifies completely, and refuses
 * otherwise. `fetch` rebuilds git's objects (commit objects byte for byte,
 * K12; trees and blobs from the mirrored objects, K2) into one pack for
 * `git index-pack`, which checks every id again.
 *
 * First-parent only (K9): merge commits' second parents are not mirrored.
 * They are recorded in `$GIT_DIR/info/grafts` (each merge and its first
 * parent), and a chain that starts mid-history is marked in
 * `$GIT_DIR/shallow`. Objects are never rewritten. Push is not supported
 * (plan 049, phase 5 later items).
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { gitObjectsOf, planClone, type ClonePlan, type GitObject } from "./clone.js";
import { OriginalsError } from "./errors.js";
import { openRepository, type OpenedRepository } from "./verify.js";

const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const log = (s: string) => process.stderr.write(`originals: ${s}\n`);

async function loadBundle(url: string): Promise<Uint8Array> {
  if (/^https:\/\//.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetching ${url}: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BUNDLE_BYTES) throw new Error(`the bundle is ${declared} bytes; the limit is ${MAX_BUNDLE_BYTES}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BUNDLE_BYTES) throw new Error(`the bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    return bytes;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("file://")) throw new Error(`unsupported bundle URL ${url}: use a path, file:// or https://`);
  return new Uint8Array(await readFile(url.startsWith("file://") ? fileURLToPath(url) : resolve(url)));
}

const TYPE = { commit: 1, tree: 2, blob: 3 } as const;

/** A git pack (version 2, no deltas) of `objects`, as chunks ending with the SHA-1 trailer. */
function packOf(objects: GitObject[]): Buffer[] {
  const hash = createHash("sha1");
  const out: Buffer[] = [];
  const push = (b: Buffer) => {
    hash.update(b);
    out.push(b);
  };
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  push(header);
  for (const o of objects) {
    let size = o.bytes.length;
    const head: number[] = [(TYPE[o.type] << 4) | (size & 0x0f)];
    size = Math.floor(size / 16);
    while (size > 0) {
      head[head.length - 1] |= 0x80;
      head.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    push(Buffer.from(head));
    push(deflateSync(o.bytes));
  }
  out.push(hash.digest());
  return out;
}

function indexPack(gitDir: string, chunks: Buffer[]): Promise<void> {
  return new Promise((done, fail) => {
    const p = spawn("git", ["index-pack", "--stdin"], { env: { ...process.env, GIT_DIR: gitDir }, stdio: ["pipe", "ignore", "inherit"] });
    p.on("error", fail);
    p.on("exit", (code) => (code === 0 ? done() : fail(new Error(`git index-pack exited ${code}`))));
    for (const c of chunks) p.stdin.write(c);
    p.stdin.end();
  });
}

/** Add lines to a file of one-entry-per-line records, keeping what is there. */
async function addLines(file: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  let existing: string[] = [];
  try {
    existing = (await readFile(file, "utf8")).split("\n").filter((l) => l.length > 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const all = [...new Set([...existing, ...lines])];
  await writeFile(file, `${all.join("\n")}\n`);
}

async function fetchInto(gitDir: string, opened: OpenedRepository, plans: ClonePlan[]): Promise<void> {
  const objects: GitObject[] = [];
  const seen = new Set<string>();
  const memo = new Map<string, string>();
  for (const plan of plans) for await (const o of gitObjectsOf(opened, plan, seen, memo)) objects.push(o);
  log(`writing ${objects.length} git objects (${objects.filter((o) => o.type === "commit").length} commits)`);
  await indexPack(gitDir, packOf(objects));
  const grafts = plans.flatMap((p) => p.grafts.map(([c, first]) => `${c} ${first}`));
  if (grafts.length) {
    await mkdir(join(gitDir, "info"), { recursive: true });
    await addLines(join(gitDir, "info", "grafts"), grafts);
    // The grafts file states what is not mirrored; git's deprecation hint about the file format is turned off for this repository only.
    await new Promise<void>((done) => spawn("git", ["config", "advice.graftFileDeprecated", "false"], { env: { ...process.env, GIT_DIR: gitDir }, stdio: "ignore" }).on("exit", () => done()));
    log(`${grafts.length} merge commits keep only their first parent: second parents are not mirrored (see ${join(gitDir, "info", "grafts")})`);
  }
  const shallow = plans.flatMap((p) => (p.shallow ? [p.shallow] : []));
  if (shallow.length) await addLines(join(gitDir, "shallow"), shallow);
}

async function main(): Promise<number> {
  const url = process.argv[3] ?? process.argv[2];
  if (!url) {
    log("usage: git clone originals::<bundle path or URL> <dir>");
    return 2;
  }
  const gitDir = process.env.GIT_DIR;
  let opened: OpenedRepository | undefined;
  let plans: ClonePlan[] = [];
  const ready = async () => {
    if (opened) return;
    const started = performance.now();
    opened = await openRepository(await loadBundle(url));
    const planned = await planClone(opened);
    plans = planned.plans;
    for (const r of planned.refused) log(`refusing ${r.ref}: ${r.reason}`);
    log(`verified ${url} offline in ${((performance.now() - started) / 1000).toFixed(1)} s; ${plans.length} ref(s) with an agreed canonical head; nothing here is current (P7.10)`);
    if (plans.length === 0) throw new Error("no ref has an agreed, completely verified canonical head; nothing to clone");
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const out = (s: string) => process.stdout.write(s);
  let batch: string[] = [];
  for await (const line of lines) {
    if (line === "capabilities") out("fetch\n\n");
    else if (line === "list" || line === "list for-push") {
      if (line === "list for-push") throw new Error("push is not supported by git-remote-originals (plan 049)");
      await ready();
      for (const p of plans) out(`${p.head} ${p.ref}\n`);
      const main = plans.find((p) => p.ref === "refs/heads/main") ?? plans[0];
      out(`@${main.ref} HEAD\n\n`);
    } else if (line.startsWith("fetch ")) batch.push(line);
    else if (line === "") {
      if (batch.length === 0) return 0;
      if (!gitDir) throw new Error("GIT_DIR is not set");
      await ready();
      const wanted = new Set(batch.map((l) => l.split(" ")[1]));
      await fetchInto(gitDir, opened!, plans.filter((p) => wanted.has(p.head)));
      batch = [];
      out("\n");
    } else if (line.startsWith("option ")) out("unsupported\n");
    else throw new Error(`unsupported command ${JSON.stringify(line)}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    log(e instanceof OriginalsError ? `${e.category} ${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
