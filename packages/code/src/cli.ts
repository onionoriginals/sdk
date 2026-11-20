#!/usr/bin/env node
/**
 * `originals-code` (plan 049): mirror git branches into Originals and verify
 * repo bundles offline.
 *
 *   originals-code identity new <file>
 *   originals-code identity public <file> [--out <public.json>]   (the DID and its log, to share)
 *   originals-code identity add <public.json> --dir <workspace>   (another delegate's or contributor's public identity)
 *   originals-code identity new-remote <identity.json> --sign-with <turnkey key id> --public-key <z6Mk… or 64 hex> --update-key-out <private.json>
 *                          (K21: a did:vh whose signing key is held in Turnkey; the file holds public data and the key reference only)
 *   originals-code rehydrate --dir <workspace> --git <repo>   (K22: rebuild every listed branch's objects from git, checked against the logs)
 *   originals-code init    --dir <workspace> --identity <file>[,<file>…] --name <name> [--threshold <n>] [--private]
 *                          (K5: a set Original whose members are the delegates; every one signs its genesis, P5.19)
 *   originals-code repo propose --dir <workspace> --signers <did>[,<did>…] --out <proposal.json>
 *                          [--add-delegate <did>[,…]] [--remove-delegate <did>[,…]] [--threshold <n>]
 *                          [--ref-threshold <ref>=<n>] [--list <ref>=<branch> --delegate <did>]
 *                          [--grant <did>=<pattern>[,<pattern>…]] [--revoke <did>]
 *   originals-code repo cosign <proposal.json> --dir <workspace> --identity <file>
 *   originals-code repo commit <proposal.json> --dir <workspace>
 *                          (K5: a repo change is an author entry signed by the threshold of delegates, and by every
 *                          delegate it adds, P5.20; members who are not together sign the proposal file in turn)
 *   originals-code mirror  --dir <workspace> --identity <file> --git <repo> [--ref refs/heads/main] [--rev <revision>] [--limit <n>] [--branch <did>]
 *                          (a remote identity file signs through Turnkey with TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID)
 *                          [--include-commits | --no-commits]
 *
 * Raw git commit objects are mirrored by default (K12, plan 049 O3). They
 * carry author and committer emails, so in a workspace marked `--private`
 * they are mirrored only with `--include-commits` (P8.2: no confidentiality).
 *                          [--contribute]   (K14: your own branch for the ref, never listed, never voting)
 *   originals-code release <tag> --dir <workspace> --identity <file>[,<file>…] [--ref refs/heads/main] [--commit <id>]
 *                          (K15, K17: record a release in the release Original, signed by the repo's threshold of
 *                          delegates; the first release creates it, which every delegate signs)
 *   originals-code import  <bundle.zip> --dir <workspace>   (verify a repo bundle offline, then take it in)
 *   originals-code package --dir <workspace> [--out <bundle.zip>] [--split <dir>] [--omit-blobs]
 *   originals-code verify  <bundle.zip> [--json] [--now <time>]
 *   originals-code serve   <bundle.zip> [--port 4173] [--host 127.0.0.1] [--now <time>]
 *
 * `verify` needs no key and makes no network request (P7.3). It never
 * reports anything current: nothing here is anchored (P7.10).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { OriginalsError } from "./errors.js";
import { openWorkspace } from "./fs.js";
import { pathGrant } from "./grants.js";
import { GitSource } from "./git.js";
import { createLocalIdentity, parseIdentity, parsePublicIdentity, publicIdentity, serializeIdentity, type LocalIdentity } from "./identity.js";
import { parseProposal, serializeProposal } from "./workspace.js";
import type { RepoDocument } from "./documents.js";
import { splitBundle } from "./split.js";
import { createRemoteIdentity, parseRemoteIdentity, REMOTE_IDENTITY_FORMAT, serializeRemoteIdentity, serializeUpdateKey } from "./remote-identity.js";
import { rehydrateObjects } from "./rehydrate.js";
import type { EntrySigner } from "@originals/vh/log";
import { encodeMultikey } from "@originals/vh/crypto";
import { openRepository, verifyRepository, type RepositoryReport } from "./verify.js";
import { createRepositoryView } from "./view.js";

const BOOLEAN_FLAGS = new Set(["--json", "--omit-blobs", "--private", "--include-commits", "--no-commits", "--contribute"]);

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

/** `--identity a.json,b.json`: each identity file, in order. */
async function identities(opts: Record<string, string | true>): Promise<LocalIdentity[]> {
  return Promise.all(need(opts, "identity").split(",").filter(Boolean).map(async (f) => parseIdentity(await readFile(f, "utf8"))));
}

const list = (v: string | true | undefined) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

function summary(r: RepositoryReport): string {
  const lines: string[] = [];
  const repo = r.repo;
  lines.push(`repo ${repo.original}`);
  lines.push(`  originals: history ${repo.report?.history.status ?? "unread"}, valid as of ${repo.report?.validAsOf?.checkpoint ?? "nothing"}${repo.error ? ` (${repo.error.code}: ${repo.error.message})` : ""}`);
  lines.push(`  code:      ${repo.code?.history.status ?? "not checked"}${repo.code?.history.failure ? ` (${repo.code.history.failure.code}: ${repo.code.history.failure.message})` : ""}`);
  if (repo.code?.authors) lines.push(`  delegates: ${repo.code.authors.dids.length}, ${repo.code.authors.threshold} of them sign each repo change (signer set, P5.19)`);
  for (const g of repo.code?.grants ?? []) lines.push(`  grant:     ${g.did} ${g.paths.join(" ")} (inherited by every branch, P5.24)`);
  for (const b of r.branches) {
    lines.push(`branch ${b.original} ${b.code?.ref ?? ""}`);
    lines.push(`  originals: history ${b.report?.history.status ?? "unread"}, entries ${b.report?.history.entries ?? 0}, valid as of ${b.report?.validAsOf?.checkpoint ?? "nothing"}${b.report?.fork ? ", FORKED (unresolved, P9.16)" : ""}`);
    if (b.code) {
      const c = b.code;
      if (c.segment.segments.length > 1 || c.binding.status === "superseded") lines.push(`  segment:   ${c.segment.index + 1} of the branch${c.segment.previous ? `, after ${c.segment.previous.did} at ${c.segment.previous.versionId}` : ""} (K13)`);
      lines.push(`  code:      ${c.history.status}${c.history.failure ? ` at entry ${c.history.failure.index} (${c.history.failure.code}: ${c.history.failure.message})` : ""}; binding ${c.binding.status}`);
      lines.push(`  content:   ${c.content.status}: ${c.content.objects} objects, ${c.content.bytes} bytes${c.content.missing.length ? `, ${c.content.missing.length} missing` : ""}${c.content.failures.length ? `, ${c.content.failures.length} failed` : ""}`);
      lines.push(`  git trees: ${c.gitBinding.status} (${c.gitBinding.checked} checked, ${c.gitBinding.unchecked} unchecked)`);
      const cb = c.commitBinding;
      lines.push(`  commits:   ${cb.status} (${cb.checked} recomputed from commit objects, ${cb.unchecked} unchecked, ${cb.claimed} claimed by the signer only)`);
      if (c.pins.length) lines.push(`  pins:      ${c.pins.length} repo version(s), last ${c.pins[c.pins.length - 1]}; parent evidence ${b.report?.parentAuthority?.status ?? "unknown"} (P5.25)`);
      const unchecked = c.grants.filter((g) => g.status !== "allowed").length;
      if (c.grants.length) lines.push(`  grants:    ${c.grants.length} editor entries (inherited path grants), ${unchecked} unchecked, ${c.historicallyAuthorizedOnly.length} historically authorized only (P5.26)`);
    }
  }
  for (const c of r.contributions) lines.push(`contribution ${c.original} ${c.ref ?? ""} by ${c.author ?? "?"}: ${c.status}${c.head ? ` at ${c.head}` : ""} (verified, never voting)`);
  if (r.releases) {
    const rel = r.releases;
    lines.push(`releases ${rel.original}`);
    lines.push(`  originals: history ${rel.report?.history.status ?? "unread"}, valid as of ${rel.report?.validAsOf?.checkpoint ?? "nothing"}${rel.report?.current ? ", current (anchored)" : ""}${rel.error ? ` (${rel.error.code}: ${rel.error.message})` : ""}`);
    lines.push(`  code:      ${rel.code?.history.status ?? "not checked"}${rel.code?.history.failure ? ` (${rel.code.history.failure.code}: ${rel.code.history.failure.message})` : ""}`);
    for (const x of rel.code?.releases ?? []) lines.push(`  ${x.tag} = ${x.commit} (${x.chain}; canonical at release: ${x.canonicalAtRelease.status})`);
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
      if (positional[0] === "public" && positional[1]) {
        const pub = `${JSON.stringify(publicIdentity(parseIdentity(await readFile(positional[1], "utf8"))))}\n`;
        if (typeof opts.out === "string") await writeFile(opts.out, pub, { flag: "wx" });
        else process.stdout.write(pub);
        return 0;
      }
      if (positional[0] === "add" && positional[1]) {
        const ws = await openWorkspace(resolve(need(opts, "dir")));
        try {
          const pub = parsePublicIdentity(await readFile(positional[1], "utf8"));
          await ws.rememberIdentity(pub);
          console.log(pub.did);
        } finally {
          await ws.close();
        }
        return 0;
      }
      if (positional[0] === "new-remote" && positional[1]) {
        // Turnkey reports an Ed25519 public key as 64 hex digits; a Multikey (z6Mk…) is taken as is.
        const given = need(opts, "public-key").replace(/^0x/, "");
        const publicKeyMultibase = /^[0-9a-fA-F]{64}$/.test(given) ? encodeMultikey("Ed25519", Uint8Array.from(given.match(/../g)!.map((x) => parseInt(x, 16)))) : given;
        const { identity, updateSecret } = await createRemoteIdentity({ kind: "turnkey", signWith: need(opts, "sign-with"), publicKeyMultibase });
        // The update key first, private and never overwritten: it alone can change the DID (P5.11).
        await writeFile(need(opts, "update-key-out"), serializeUpdateKey(identity.did, updateSecret), { mode: 0o600, flag: "wx" });
        await writeFile(positional[1], serializeRemoteIdentity(identity), { flag: "wx" });
        console.log(identity.did);
        return 0;
      }
      if (positional[0] !== "new" || !positional[1]) throw new Error("usage: originals-code identity new <file> | identity new-remote <file> --sign-with <id> --public-key <z6Mk…> --update-key-out <file> | identity public <file> [--out <file>] | identity add <public.json> --dir <workspace>");
      const id = await createLocalIdentity();
      await writeFile(positional[1], serializeIdentity(id), { mode: 0o600, flag: "wx" });
      console.log(id.did);
      return 0;
    }
    case "repo": {
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      try {
        if (!ws.repo) throw new Error("run init or import first");
        if (positional[0] === "propose") {
          const added = list(opts["add-delegate"]);
          const removed = list(opts["remove-delegate"]);
          const draft = await ws.workspace.proposeRepo(ws.repo, list(opts.signers), (s) => {
            const document: RepoDocument = { ...s.document, delegates: [...new Set([...s.document.delegates.filter((d) => !removed.includes(d)), ...added])].sort() };
            if (typeof opts["ref-threshold"] === "string") {
              const [ref, n] = opts["ref-threshold"].split("=");
              document.refs[ref] = { ...(document.refs[ref] ?? { branches: {} }), threshold: Number(n) };
            }
            if (typeof opts.list === "string") {
              const at = opts.list.indexOf("=");
              const rule = document.refs[opts.list.slice(0, at)] ?? { threshold: 1, branches: {} };
              rule.branches[need(opts, "delegate")] = opts.list.slice(at + 1);
              document.refs[opts.list.slice(0, at)] = rule;
            }
            let editors = s.editors;
            if (typeof opts.revoke === "string") editors = editors.filter((g) => g.did !== opts.revoke);
            if (typeof opts.grant === "string") {
              const at = opts.grant.lastIndexOf("=");
              const did = opts.grant.slice(0, at);
              editors = [...editors.filter((g) => g.did !== did), pathGrant(did, list(opts.grant.slice(at + 1)))].sort((a, b) => (a.did < b.did ? -1 : 1));
            }
            return { document, threshold: typeof opts.threshold === "string" ? Number(opts.threshold) : s.threshold, editors };
          });
          await writeFile(need(opts, "out"), serializeProposal(draft), { flag: "wx" });
          console.log(draft.display);
          console.log(`${need(opts, "out")}: signed by none of ${list(opts.signers).length} yet; each runs \`repo cosign\`, then \`repo commit\``);
          return 0;
        }
        if (positional[0] === "cosign" && positional[1]) {
          const [identity] = await identities(opts);
          await ws.rememberIdentity(identity);
          const draft = await ws.workspace.cosignRepo(parseProposal(await readFile(positional[1], "utf8")), identity);
          await writeFile(positional[1], serializeProposal(draft));
          console.log(`${identity.did} signed; ${draft.proofs?.length ?? 0} signature(s) so far`);
          return 0;
        }
        if (positional[0] === "commit" && positional[1]) {
          const checkpoint = await ws.workspace.commitRepo(parseProposal(await readFile(positional[1], "utf8")));
          console.log(`committed ${ws.repo} at ${checkpoint}`);
          return 0;
        }
        throw new Error("usage: originals-code repo propose | repo cosign <proposal.json> | repo commit <proposal.json>");
      } finally {
        await ws.close();
      }
    }
    case "init": {
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      try {
        if (ws.repo) throw new Error(`the workspace already has repo ${ws.repo}`);
        const [identity, ...delegates] = await identities(opts);
        for (const id of [identity, ...delegates]) await ws.rememberIdentity(id);
        const repo = await ws.workspace.initRepo({ name: need(opts, "name"), identity, delegates, ...(typeof opts.threshold === "string" ? { threshold: Number(opts.threshold) } : {}) });
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
        const text = await readFile(need(opts, "identity"), "utf8");
        // K21: a remote identity signs through Turnkey; its file holds no secret.
        const remote = text.includes(REMOTE_IDENTITY_FORMAT) ? parseRemoteIdentity(text) : undefined;
        let sign: EntrySigner | undefined;
        if (remote) {
          const { turnkeyCredentials, turnkeyEntrySigner, TURNKEY_ENV } = await import("./turnkey.js");
          const credentials = turnkeyCredentials();
          if (!credentials) throw new Error(`${remote.did} signs through Turnkey: set ${TURNKEY_ENV.join(", ")}`);
          sign = turnkeyEntrySigner(remote, credentials);
        }
        const identity = remote ? { did: remote.did, log: remote.log } : parseIdentity(text);
        await ws.rememberIdentity(identity);
        const started = performance.now();
        if (opts["include-commits"] === true && opts["no-commits"] === true) throw new Error("--include-commits and --no-commits contradict each other");
        const commits = opts["include-commits"] === true ? true : opts["no-commits"] === true ? false : undefined;
        const contribute = opts.contribute === true;
        const mine = contribute ? await ws.workspace.findBranch(ws.contributions, identity.did, ref) : undefined;
        const r = await ws.workspace.mirror({
          repo: ws.repo,
          ref,
          identity,
          ...(sign ? { sign } : {}),
          ...(typeof opts.branch === "string" ? { branch: opts.branch } : {}),
          source,
          private: ws.private,
          ...(contribute ? { contribute, ...(mine ? { branch: mine } : {}) } : {}),
          ...(commits !== undefined ? { commits } : {}),
          ...(typeof opts.limit === "string" ? { limit: Number(opts.limit) } : {}),
        });
        const s = source.stats;
        console.log(`${r.created ? "created" : "extended"} ${r.branch}: +${r.appended} entries, head ${r.head.commit} (${r.head.versionId})`);
        console.log(`converted ${s.commits} commits, ${s.trees} trees, ${s.blobs} blobs (${s.blobBytes} bytes) in ${((performance.now() - started) / 1000).toFixed(1)} s`);
        if (r.commitObjects === "omitted-private") console.log("commit objects not mirrored: the workspace is marked private (pass --include-commits to opt in); commit ids are claimed only");
        if (r.contribution) {
          await ws.setContributions([...ws.contributions.filter((d) => d !== mine), r.branch]);
          console.log("a contribution: verified with the repo's bundles, never voting for a canonical head (K14)");
        }
        if (r.needsListing) console.log(`the delegates list this branch with a repo change: originals-code repo propose --list ${ref}=${r.branch} --delegate ${identity.did} --signers <dids>`);
      } finally {
        source.close();
        await ws.close();
      }
      return 0;
    }
    case "rehydrate": {
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      const source = new GitSource(resolve(need(opts, "git")));
      try {
        if (!ws.repo) throw new Error("run init or import first");
        const started = performance.now();
        const r = await rehydrateObjects(ws.workspace, ws.repo, source);
        const s = source.stats;
        console.log(`rehydrated ${r.commits} commits of ${r.branches} branch Original(s) from git: ${s.trees} trees, ${s.blobs} blobs (${s.blobBytes} bytes) in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      } finally {
        source.close();
        await ws.close();
      }
      return 0;
    }
    case "release": {
      if (!positional[0]) throw new Error("usage: originals-code release <tag> --dir <workspace> --identity <file> [--ref refs/heads/main] [--commit <id>]");
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      try {
        if (!ws.repo) throw new Error("run init first");
        const signers = await identities(opts);
        for (const id of signers) await ws.rememberIdentity(id);
        const r = await ws.workspace.release(ws.repo, signers, { tag: positional[0], ...(typeof opts.ref === "string" ? { ref: opts.ref } : {}), ...(typeof opts.commit === "string" ? { commit: opts.commit } : {}) });
        const m = r.manifest;
        console.log(`${r.created ? "created release Original" : "released in"} ${r.releases} (${r.versionId}): ${m.tag} = ${m.commit}`);
        console.log(`  from ${m.branch} at ${m.versionId}; canonical ${m.ref} was ${m.canonical.status}${m.canonical.head ? ` at ${m.canonical.head}` : ""} (threshold ${m.canonical.threshold})`);
      } finally {
        await ws.close();
      }
      return 0;
    }
    case "import": {
      if (!positional[0]) throw new Error("usage: originals-code import <bundle.zip> --dir <workspace>");
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      try {
        const r = await ws.workspace.importBundle(new Uint8Array(await readFile(positional[0])));
        if (ws.repo && ws.repo !== r.repo) throw new Error(`the workspace holds repo ${ws.repo}, the bundle ${r.repo}`);
        if (!ws.repo) await ws.setRepo(r.repo);
        await ws.setContributions([...ws.contributions, ...r.contributions]);
        console.log(`imported ${r.repo}: ${r.report.branches.length} branch Originals, ${r.contributions.length} contributions`);
      } finally {
        await ws.close();
      }
      return 0;
    }
    case "package": {
      const ws = await openWorkspace(resolve(need(opts, "dir")));
      try {
        if (!ws.repo) throw new Error("run init first");
        if (typeof opts.out !== "string" && typeof opts.split !== "string") throw new Error("--out <bundle.zip> or --split <dir> is required");
        const bytes = await ws.workspace.package(ws.repo, { omitBlobs: opts["omit-blobs"] === true, contributions: ws.contributions });
        if (typeof opts.out === "string") {
          await writeFile(opts.out, bytes);
          console.log(`${opts.out}: ${bytes.length} bytes`);
        }
        if (typeof opts.split === "string") {
          // The split layout (K19): static files, logs, trees and commit objects first, each other object by digest.
          const files = await splitBundle(bytes);
          let total = 0;
          for (const [name, data] of files) {
            const path = join(resolve(opts.split), ...name.split("/"));
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, data);
            total += data.length;
          }
          console.log(`${opts.split}: ${files.size} files, ${total} bytes`);
        }
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
      // A contribution that fails is reported, but does not fail the repository: anyone may publish one (K14).
      const contributed = new Set(report.contributions.map((c) => c.original));
      const ok = report.repo.code?.history.status === "valid" && (!report.releases || report.releases.code?.history.status === "valid") && report.branches.every((b) => contributed.has(b.original) || (b.code?.history.status === "valid" && b.report?.validAsOf));
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
      console.error("usage: originals-code identity new|public|add | init | repo propose|cosign|commit | mirror | release <tag> | import <bundle.zip> | package | verify <bundle.zip> | serve <bundle.zip>");
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
