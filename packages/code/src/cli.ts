#!/usr/bin/env node
/**
 * `originals-code` (plan 049): mirror git branches into Originals and verify
 * repo bundles offline.
 *
 *   originals-code identity new <file>
 *   originals-code init    --dir <workspace> --identity <file> --name <name> [--private]
 *   originals-code mirror  --dir <workspace> --identity <file> --git <repo> [--ref refs/heads/main] [--rev <revision>] [--limit <n>]
 *                          [--include-commits | --no-commits]
 *
 * Raw git commit objects are mirrored by default (K12, plan 049 O3). They
 * carry author and committer emails, so in a workspace marked `--private`
 * they are mirrored only with `--include-commits` (P8.2: no confidentiality).
 *   originals-code package --dir <workspace> --out <bundle.zip> [--omit-blobs]
 *   originals-code verify  <bundle.zip> [--json] [--now <time>]
 *   originals-code serve   <bundle.zip> [--port 4173] [--host 127.0.0.1] [--now <time>]
 *
 * `verify` needs no key and makes no network request (P7.3). It never
 * reports anything current: nothing here is anchored (P7.10).
 */
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { OriginalsError } from "./errors.js";
import { openWorkspace } from "./fs.js";
import { GitSource } from "./git.js";
import { createLocalIdentity, parseIdentity, serializeIdentity } from "./identity.js";
import { openRepository, verifyRepository, type RepositoryReport } from "./verify.js";
import { createRepositoryView } from "./view.js";

const BOOLEAN_FLAGS = new Set(["--json", "--omit-blobs", "--private", "--include-commits", "--no-commits"]);

function flags(args: string[]): { positional: string[]; opts: Record<string, string | true> } {
  const positional: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) positional.push(a);
    else if (i + 1 < args.length && !args[i + 1].startsWith("--") && !BOOLEAN_FLAGS.has(a)) opts[a.slice(2)] = args[++i];
    else opts[a.slice(2)] = true;
  }
  return { positional, opts };
}

function need(opts: Record<string, string | true>, name: string): string {
  const v = opts[name];
  if (typeof v !== "string") throw new Error(`--${name} is required`);
  return v;
}

function summary(r: RepositoryReport): string {
  const lines: string[] = [];
  const repo = r.repo;
  lines.push(`repo ${repo.original}`);
  lines.push(`  originals: history ${repo.report?.history.status ?? "unread"}, valid as of ${repo.report?.validAsOf?.checkpoint ?? "nothing"}${repo.error ? ` (${repo.error.code}: ${repo.error.message})` : ""}`);
  lines.push(`  code:      ${repo.code?.history.status ?? "not checked"}${repo.code?.history.failure ? ` (${repo.code.history.failure.code}: ${repo.code.history.failure.message})` : ""}`);
  for (const b of r.branches) {
    lines.push(`branch ${b.original} ${b.code?.ref ?? ""}`);
    lines.push(`  originals: history ${b.report?.history.status ?? "unread"}, entries ${b.report?.history.entries ?? 0}, valid as of ${b.report?.validAsOf?.checkpoint ?? "nothing"}${b.report?.fork ? ", FORKED (unresolved, P9.16)" : ""}`);
    if (b.code) {
      const c = b.code;
      lines.push(`  code:      ${c.history.status}${c.history.failure ? ` at entry ${c.history.failure.index} (${c.history.failure.code}: ${c.history.failure.message})` : ""}; binding ${c.binding.status}`);
      lines.push(`  content:   ${c.content.status}: ${c.content.objects} objects, ${c.content.bytes} bytes${c.content.missing.length ? `, ${c.content.missing.length} missing` : ""}${c.content.failures.length ? `, ${c.content.failures.length} failed` : ""}`);
      lines.push(`  git trees: ${c.gitBinding.status} (${c.gitBinding.checked} checked, ${c.gitBinding.unchecked} unchecked)`);
      const cb = c.commitBinding;
      lines.push(`  commits:   ${cb.status} (${cb.checked} recomputed from commit objects, ${cb.unchecked} unchecked, ${cb.claimed} claimed by the signer only)`);
      const outside = c.grants.filter((g) => g.status !== "allowed").length;
      if (c.grants.length) lines.push(`  grants:    ${c.grants.length} editor entries, ${outside} not allowed, ${c.historicallyAuthorizedOnly.length} historically authorized only`);
    }
  }
  if (r.canonicalStatus === "incomplete") lines.push("canonical: incomplete — the repo Original or its document did not verify");
  for (const c of r.canonical) {
    lines.push(`canonical ${c.ref} (threshold ${c.threshold}): ${c.status}${c.head ? ` ${c.head.commit} (votes: ${c.head.votes.length})` : ""}${c.reason ? ` — ${c.reason}` : ""}`);
  }
  lines.push("Nothing is current: these Originals are not anchored, so each is valid only as of its checkpoint (P7.10).");
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, opts } = flags(rest);
  switch (command) {
    case "identity": {
      if (positional[0] !== "new" || !positional[1]) throw new Error("usage: originals-code identity new <file>");
      const id = await createLocalIdentity();
      await writeFile(positional[1], serializeIdentity(id), { mode: 0o600, flag: "wx" });
      console.log(id.did);
      return 0;
    }
    case "init": {
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      try {
        if (ws.repo) throw new Error(`the workspace already has repo ${ws.repo}`);
        const identity = parseIdentity(await readFile(need(opts, "identity"), "utf8"));
        await ws.rememberIdentity(identity);
        const repo = await ws.workspace.initRepo({ name: need(opts, "name"), identity });
        await ws.setRepo(repo, { private: opts.private === true });
        console.log(repo);
      } finally {
        await ws.close();
      }
      return 0;
    }
    case "mirror": {
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      const ref = typeof opts.ref === "string" ? opts.ref : "refs/heads/main";
      const source = new GitSource(resolve(need(opts, "git")), typeof opts.rev === "string" ? { revisions: { [ref]: opts.rev } } : {});
      try {
        if (!ws.repo) throw new Error("run init first");
        const identity = parseIdentity(await readFile(need(opts, "identity"), "utf8"));
        await ws.rememberIdentity(identity);
        const started = performance.now();
        if (opts["include-commits"] === true && opts["no-commits"] === true) throw new Error("--include-commits and --no-commits contradict each other");
        const commits = opts["include-commits"] === true ? true : opts["no-commits"] === true ? false : undefined;
        const r = await ws.workspace.mirror({
          repo: ws.repo,
          ref,
          identity,
          source,
          private: ws.private,
          ...(commits !== undefined ? { commits } : {}),
          ...(typeof opts.limit === "string" ? { limit: Number(opts.limit) } : {}),
        });
        const s = source.stats;
        console.log(`${r.created ? "created" : "extended"} ${r.branch}: +${r.appended} entries, head ${r.head.commit} (${r.head.versionId})`);
        console.log(`converted ${s.commits} commits, ${s.trees} trees, ${s.blobs} blobs (${s.blobBytes} bytes) in ${((performance.now() - started) / 1000).toFixed(1)} s`);
        if (r.commitObjects === "omitted-private") console.log("commit objects not mirrored: the workspace is marked private (pass --include-commits to opt in); commit ids are claimed only");
        if (r.needsListing) console.log("the repo's author must list this branch in the repo document");
      } finally {
        source.close();
        await ws.close();
      }
      return 0;
    }
    case "package": {
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      try {
        if (!ws.repo) throw new Error("run init first");
        const bytes = await ws.workspace.package(ws.repo, { omitBlobs: opts["omit-blobs"] === true });
        await writeFile(need(opts, "out"), bytes);
        console.log(`${need(opts, "out")}: ${bytes.length} bytes`);
      } finally {
        await ws.close();
      }
      return 0;
    }
    case "verify": {
      if (!positional[0]) throw new Error("usage: originals-code verify <bundle.zip> [--json] [--now <time>]");
      const now = typeof opts.now === "string" ? Date.parse(opts.now) : undefined;
      if (now !== undefined && Number.isNaN(now)) throw new Error("--now is an ISO 8601 time");
      const report = await verifyRepository(new Uint8Array(await readFile(positional[0])), now !== undefined ? { now } : {});
      console.log(opts.json === true ? JSON.stringify(report, null, 2) : summary(report));
      const ok = report.repo.code?.history.status === "valid" && report.branches.every((b) => b.code?.history.status === "valid" && b.report?.validAsOf);
      return ok ? 0 : 1;
    }
    case "serve": {
      // A read-only, GitHub-like view of a verified bundle (K11). Local by default.
      if (!positional[0]) throw new Error("usage: originals-code serve <bundle.zip> [--port 4173] [--host 127.0.0.1]");
      const now = typeof opts.now === "string" ? Date.parse(opts.now) : undefined;
      if (now !== undefined && Number.isNaN(now)) throw new Error("--now is an ISO 8601 time");
      const started = performance.now();
      const opened = await openRepository(new Uint8Array(await readFile(positional[0])), now !== undefined ? { now } : {});
      console.log(summary(opened.report));
      console.log(`verified in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      const view = createRepositoryView(opened);
      const port = typeof opts.port === "string" ? Number(opts.port) : 4173;
      const host = typeof opts.host === "string" ? opts.host : "127.0.0.1";
      const server = createServer((req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405).end();
          return;
        }
        view.handle(req.url ?? "/").then(
          (r) => {
            res.writeHead(r.status, { "content-type": r.type, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'", "x-content-type-options": "nosniff" });
            res.end(req.method === "HEAD" ? undefined : r.body);
          },
          (e: unknown) => {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(e instanceof Error ? e.message : String(e));
          },
        );
      });
      await new Promise<void>((done, fail) => {
        server.once("error", (e: NodeJS.ErrnoException) => fail(new Error(e.code === "EADDRINUSE" ? `port ${port} is in use; pass --port` : e.message)));
        server.listen(port, host, done);
      });
      console.log(`serving http://${host === "0.0.0.0" ? "localhost" : host}:${port}/  (Ctrl-C to stop)`);
      return new Promise<number>(() => {});
    }
    default:
      console.error("usage: originals-code identity new <file> | init | mirror | package | verify <bundle.zip> | serve <bundle.zip>");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof OriginalsError ? `${e.category} ${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
