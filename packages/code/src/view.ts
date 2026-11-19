/**
 * A read-only, GitHub-like view of a verified repo bundle (plan 049,
 * PROVISIONAL K11). Every page is rendered from `openRepository`: only
 * entries through each Original's verified checkpoint are shown, and the
 * verification results are shown beside the content, separately, as the
 * report gives them (section 7). Nothing is ever shown as current (P7.10).
 *
 * A commit is shown by its id, the DID that signed its entry and the entry's
 * claimed versionTime (unanchored ordering is claimed only, P9.8). When the
 * bundle carries the commit's raw commit object and the verifier recomputed
 * the commit id from it (K12, `commitBinding`), its message and git author
 * are shown too, as text; otherwise the id is the signer's claim.
 */
import { signerOf, type EntryState } from "@originals/vh/originals";
import type { LogEntry } from "@originals/vh/log";
import { metadataOf } from "./branch.js";
import type { BranchMetadata, RepoDocument } from "./documents.js";
import { diffTrees, readTree, type Tree, type TreeEntry } from "./objects.js";
import { decodeCommitText } from "./commit-text.js";
import type { OpenedRepository, RepositoryReport } from "./verify.js";

export interface ViewResponse {
  status: number;
  type: string;
  body: string | Uint8Array;
}

interface Entry {
  index: number;
  versionId: string;
  time: string;
  signer: { role: "author" | "editor"; did: string };
  root: string;
  code: BranchMetadata | null;
}

interface Branch {
  index: number;
  original: string;
  name: string;
  result: RepositoryReport["branches"][number];
  entries: Entry[];
}

const PAGE = 30;
const MAX_BLOB_LINES = 20_000;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_DIFF_FILES = 300;
const decoder = new TextDecoder("utf-8", { fatal: true });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const short = (s: string, n = 7) => s.slice(0, n);
const shortDid = (did: string) => (did.length > 26 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did);
const did = (d: string) => `<code class="did" title="${esc(d)}">${esc(shortDid(d))}</code>`;
const pathUrl = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const stateOf = (e: LogEntry) => e.state as unknown as EntryState;
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function text(b: Uint8Array): string | null {
  if (b.subarray(0, 8000).includes(0)) return null;
  try {
    return decoder.decode(b);
  } catch {
    return null;
  }
}

type Tone = "good" | "bad" | "warn" | "muted";
const badge = (label: string, value: string, tone: Tone, title = "") => `<span class="badge ${tone}"${title ? ` title="${esc(title)}"` : ""}><b>${esc(label)}</b>${esc(value)}</span>`;
const tone = (status: string | undefined | null): Tone =>
  status === "valid" || status === "agreed" || status === "confirmed" || status === "complete" || status === "matches" || status === "allowed" || status === "computed"
    ? "good"
    : status === "incomplete" || status === "partial" || status === "unchecked" || status === "not-checked" || status === "no-quorum"
      ? "warn"
      : status
        ? "bad"
        : "muted";

/** Build the viewer for an opened repository. `handle` maps a URL path and query to a page. */
export function createRepositoryView(repo: OpenedRepository): { handle(url: string): Promise<ViewResponse> } {
  const { report, objects } = repo;
  const entriesOf = (original: string): Entry[] =>
    (repo.entries.get(original) ?? []).map((e, index) => {
      const s = stateOf(e);
      const signer = signerOf(s);
      let code: BranchMetadata | null = null;
      try {
        code = metadataOf(e);
      } catch {
        code = null;
      }
      return { index, versionId: e.versionId, time: e.versionTime, signer: { role: signer.role, did: signer.ref.did }, root: s.asset.resource.digest, code };
    });
  const repoEntries = repo.entries.get(report.manifest.repo) ?? [];
  const repoName = repoEntries.length ? stateOf(repoEntries[repoEntries.length - 1]).asset.name : "repository";
  const branches: Branch[] = report.branches.map((result, index) => {
    const entries = entriesOf(result.original);
    const last = repo.entries.get(result.original)?.at(-1);
    return { index, original: result.original, name: result.code?.ref?.replace(/^refs\/heads\//, "") ?? (last ? stateOf(last).asset.name : result.original), result, entries };
  });

  /**
   * The commit object's text, only for an entry whose commit id the verifier
   * recomputed from it (K12): named by the entry, held, before any code
   * failure, and not a recorded mismatch.
   */
  async function commitInfo(b: Branch, e: Entry): Promise<{ author: string | null; message: string } | null> {
    const c = b.result.code;
    const digest = e.code?.commitObject;
    if (!c || !digest) return null;
    if (c.history.failure && c.history.failure.index <= e.index) return null;
    if (c.commitBinding.mismatches.some((m) => m.versionId === e.versionId)) return null;
    const raw = await objects(digest);
    return raw ? decodeCommitText(raw) : null;
  }
  const commitStatus = (b: Branch, e: Entry, info: unknown): string =>
    b.result.code?.commitBinding.mismatches.some((m) => m.versionId === e.versionId) ? "mismatch" : info ? "matches" : e.code?.commitObject ? "unchecked" : "claimed";

  const delegateOf = (d: string) => {
    const i = report.repo.code?.document?.delegates.indexOf(d) ?? -1;
    return i >= 0 ? `delegate ${i + 1}` : null;
  };

  /** The branch to open first: the canonical head's for the first agreed ref, else the first branch with entries. */
  function defaultBranch(): Branch | undefined {
    for (const c of report.canonical) {
      if (c.status !== "agreed" || !c.head) continue;
      const voter = c.delegates.find((d) => d.head === c.head!.commit);
      const b = branches.find((x) => x.original === voter?.branch);
      if (b) return b;
    }
    return branches.find((b) => b.entries.length > 0);
  }

  async function lookup(root: string, path: string): Promise<{ entry: TreeEntry; tree?: Tree } | null> {
    let entry: TreeEntry = { mode: "40000", digest: root };
    for (const name of path.split("/").filter(Boolean)) {
      if (entry.mode !== "40000") return null;
      const child = (await readTree(entry.digest, objects)).entries[name];
      if (!child) return null;
      entry = child;
    }
    return entry.mode === "40000" ? { entry, tree: await readTree(entry.digest, objects) } : { entry };
  }

  // ---- layout ----

  function layout(title: string, body: string, branch?: Branch): string {
    const tabs = branch
      ? `<nav class="tabs"><a href="/b/${branch.index}">Code</a><a href="/b/${branch.index}/commits">Commits <span class="count">${branch.entries.length}</span></a><a href="/verify">Verification</a></nav>`
      : `<nav class="tabs"><a href="/">Code</a><a href="/verify">Verification</a></nav>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(repoName)}</title><style>${CSS}</style></head><body>
<header class="top"><a class="logo" href="/">◈ originals<span>code</span></a><span class="repo-did" title="${esc(report.manifest.repo)}">${esc(shortDid(report.manifest.repo))}</span></header>
<div class="repohead"><div class="wrap"><h1><a href="/">${esc(repoName)}</a> ${repoBadge()}</h1>${tabs}</div></div>
<main class="wrap">${body}</main>
<footer class="wrap">Verified offline from the bundle at repo checkpoint <code>${esc(report.manifest.checkpoint)}</code>. Nothing here is anchored, so every result is valid only as of its checkpoint, never current (P7.10). Commit messages are shown only from commit objects the verifier checked (plan 049, K12).</footer>
</body></html>`;
  }

  function repoBadge(): string {
    const ok = report.repo.report?.validAsOf && report.repo.code?.history.status === "valid";
    return badge("repo ", ok ? "verified" : (report.repo.code?.history.status ?? report.repo.report?.history.status ?? "unverified"), ok ? "good" : "bad");
  }

  function branchBadges(b: Branch): string {
    const r = b.result;
    const c = r.code;
    const out = [
      badge("originals ", r.report?.fork ? "forked" : (r.report?.history.status ?? "unread"), r.report?.fork ? "bad" : tone(r.report?.history.status), r.report?.validAsOf ? `valid as of ${r.report.validAsOf.checkpoint}` : "no valid checkpoint"),
      badge("code ", c?.history.status ?? "not checked", tone(c?.history.status), c?.history.failure ? `${c.history.failure.code}: ${c.history.failure.message}` : ""),
      badge("listed ", c?.binding.status ?? "not checked", tone(c?.binding.status), c?.binding.reason ?? ""),
      badge("git trees ", c?.gitBinding.status ?? "unchecked", tone(c?.gitBinding.status), c ? `${c.gitBinding.checked} checked, ${c.gitBinding.unchecked} unchecked` : ""),
      badge("content ", c?.content.status ?? "unknown", tone(c?.content.status), c ? `${c.content.objects} objects, ${c.content.missing.length} missing` : ""),
    ];
    return `<div class="badges">${out.join("")}</div>`;
  }

  function branchSwitcher(current: Branch, suffix: (b: Branch) => string): string {
    if (branches.length < 2) return `<span class="btn">⎇ ${esc(current.name)}</span>`;
    return `<details class="switch"><summary class="btn">⎇ ${esc(current.name)} <small>${esc(delegateOf(current.result.code?.binding.delegate ?? current.result.code?.author ?? "") ?? "")}</small> ▾</summary><div class="menu">${branches
      .map((b) => `<a href="${suffix(b)}"${b === current ? ' class="on"' : ""}>${esc(b.name)} <small>${esc(delegateOf(b.result.code?.binding.delegate ?? b.result.code?.author ?? "") ?? shortDid(b.original))}</small></a>`)
      .join("")}</div></details>`;
  }

  function commitLine(b: Branch, e: Entry, extra = ""): string {
    const sha = e.code?.commit ?? "";
    const role = e.signer.role === "editor" ? `<span class="role">editor</span>` : "";
    return `<div class="commitline"><a class="sha" href="/b/${b.index}/v/${encodeURIComponent(e.versionId)}">${esc(short(sha))}</a> signed by ${did(e.signer.did)}${role} <span class="muted">on ${esc(e.time.slice(0, 10))}</span>${extra}</div>`;
  }

  function crumbs(b: Branch, e: Entry, path: string): string {
    const parts = path.split("/").filter(Boolean);
    let at = "";
    const links = [`<a href="/b/${b.index}/tree/${encodeURIComponent(e.versionId)}">${esc(repoName)}</a>`];
    parts.forEach((p, i) => {
      at = at ? `${at}/${p}` : p;
      links.push(i === parts.length - 1 ? `<b>${esc(p)}</b>` : `<a href="/b/${b.index}/tree/${encodeURIComponent(e.versionId)}/${pathUrl(at)}">${esc(p)}</a>`);
    });
    return `<div class="crumbs">${links.join(" / ")}</div>`;
  }

  // ---- pages ----

  async function home(): Promise<ViewResponse> {
    const b = defaultBranch();
    if (!b) return page("Repository", `${overview()}<div class="box empty">No branch has a verified entry.</div>`);
    return tree(b, b.entries[b.entries.length - 1], "", true);
  }

  function overview(): string {
    const doc: RepoDocument | null | undefined = report.repo.code?.document;
    const refs = report.canonical
      .map(
        (c) =>
          `<li><b>${esc(c.ref.replace(/^refs\/heads\//, ""))}</b> ${badge("canonical ", c.status, tone(c.status), c.reason ?? "")} ${c.head ? `<code>${esc(short(c.head.commit, 10))}</code> · ${c.head.votes.length} of ${c.delegates.length} delegate${c.delegates.length === 1 ? "" : "s"} agree (threshold ${c.threshold})` : esc(c.reason ?? "")}</li>`,
      )
      .join("");
    const canonical = report.canonicalStatus === "computed" ? refs || "<li class=muted>No refs listed.</li>" : `<li>${badge("canonical ", report.canonicalStatus, tone(report.canonicalStatus))} the repo Original did not verify, so no ref has a canonical head.</li>`;
    return `<aside class="about"><h3>About</h3><p class="muted">Signed history, verified offline. Canonical heads come from delegate agreement, never from timestamps (P2.1).</p>
<h4>Canonical heads</h4><ul class="plain">${canonical}</ul>
<h4>Delegates</h4><ul class="plain">${(doc?.delegates ?? []).map((d, i) => `<li>${i + 1}. ${did(d)}</li>`).join("") || "<li class=muted>unknown</li>"}</ul>
${doc && doc.grants.length ? `<h4>Path grants</h4><ul class="plain">${doc.grants.map((g) => `<li>${did(g.did)}<br>${g.paths.map((p) => `<code>${esc(p)}</code>`).join(" ")}</li>`).join("")}</ul>` : ""}
<h4>Branches</h4><ul class="plain">${branches.map((b) => `<li><a href="/b/${b.index}">${esc(b.name)}</a> <span class="muted">${b.entries.length} entries</span></li>`).join("")}</ul></aside>`;
  }

  async function tree(b: Branch, e: Entry, path: string, isHome = false): Promise<ViewResponse> {
    const found = await lookup(e.root, path);
    if (!found) return notFound();
    if (!found.tree) return blob(b, e, path, false);
    const names = Object.keys(found.tree.entries).sort((x, y) => {
      const dx = found.tree!.entries[x].mode === "40000" ? 0 : 1;
      const dy = found.tree!.entries[y].mode === "40000" ? 0 : 1;
      return dx - dy || (x.toLowerCase() < y.toLowerCase() ? -1 : 1);
    });
    const at = (n: string) => (path ? `${path}/${n}` : n);
    const v = encodeURIComponent(e.versionId);
    const rows = names
      .map((n) => {
        const t = found.tree!.entries[n];
        const dir = t.mode === "40000";
        const icon = dir ? "📁" : t.mode === "120000" ? "↪" : "📄";
        return `<tr><td class="icon">${icon}</td><td><a href="/b/${b.index}/${dir ? "tree" : "blob"}/${v}/${pathUrl(at(n))}">${esc(n)}</a></td><td class="muted mono">${t.mode === "100755" ? "executable" : t.mode === "120000" ? "symlink" : ""}</td></tr>`;
      })
      .join("");
    const up = path ? `<tr><td class="icon"></td><td><a href="/b/${b.index}/tree/${v}/${pathUrl(path.split("/").slice(0, -1).join("/"))}">..</a></td><td></td></tr>` : "";
    const latest = e === b.entries[b.entries.length - 1];
    const head = `<div class="bar">${branchSwitcher(b, (x) => `/b/${x.index}`)}${path ? crumbs(b, e, path) : ""}<span class="grow"></span><a class="btn" href="/b/${b.index}/commits">🕘 ${b.entries.length} commits</a></div>`;
    const readmeName = names.find((n) => /^readme(\.md|\.markdown|\.txt)?$/i.test(n) && found.tree!.entries[n].mode !== "40000");
    let readme = "";
    if (readmeName) {
      const raw = await objects(found.tree.entries[readmeName].digest);
      const t = raw ? text(raw) : null;
      if (t !== null) readme = `<div class="box readme"><div class="boxhead">📖 ${esc(readmeName)}</div><div class="markdown">${/\.(md|markdown)$/i.test(readmeName) ? markdown(t, (href) => linkFor(b, e, path, href)) : `<pre>${esc(t)}</pre>`}</div></div>`;
    }
    const pinned = latest ? "" : `<div class="note">Viewing the tree at an earlier entry, <code>${esc(e.versionId)}</code>. <a href="/b/${b.index}/tree/${encodeURIComponent(b.entries[b.entries.length - 1].versionId)}/${pathUrl(path)}">Go to the branch head</a>.</div>`;
    const main = `${head}${pinned}${isHome ? branchBadges(b) : ""}<div class="box"><div class="boxhead">${commitLine(b, e, ` <span class="grow"></span><code class="muted" title="git tree id, recomputed from the objects">tree ${esc(short(e.code?.tree ?? "", 10))}</code>`)}</div><table class="files">${up}${rows}</table></div>${readme}`;
    return page(path || repoName, isHome ? `<div class="cols"><div class="main">${main}</div>${overview()}</div>` : main, b);
  }

  function linkFor(b: Branch, e: Entry, dir: string, href: string): string | null {
    if (/^(https?:|mailto:)/i.test(href)) return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href.startsWith("#") ? href : null;
    const [p] = href.split("#");
    const parts = (href.startsWith("/") ? [] : dir.split("/").filter(Boolean)).concat(p.split("/"));
    const out: string[] = [];
    for (const s of parts) {
      if (s === "" || s === ".") continue;
      if (s === "..") out.pop();
      else out.push(s);
    }
    return `/b/${b.index}/blob/${encodeURIComponent(e.versionId)}/${pathUrl(out.join("/"))}`;
  }

  async function blob(b: Branch, e: Entry, path: string, plain: boolean): Promise<ViewResponse> {
    const found = await lookup(e.root, path);
    if (!found) return notFound();
    if (found.tree) return tree(b, e, path);
    const raw = await objects(found.entry.digest);
    const head = `<div class="bar">${branchSwitcher(b, (x) => `/b/${x.index}`)}${crumbs(b, e, path)}</div>`;
    if (!raw) return page(path, `${head}<div class="box empty">The bundle does not carry this file's bytes (<code>${esc(found.entry.digest)}</code>): content is reported missing, never as a pass.</div>`, b);
    const t = text(raw);
    const md = /\.(md|markdown)$/i.test(path) && t !== null && !plain;
    const tools = `<span class="grow"></span>${/\.(md|markdown)$/i.test(path) && t !== null ? `<a class="btn sm" href="?${plain ? "" : "plain=1"}">${plain ? "Preview" : "Code"}</a>` : ""}<a class="btn sm" href="/raw/${encodeURIComponent(found.entry.digest)}">Raw</a>`;
    const info = `${t !== null ? `${t.split("\n").length} lines · ` : ""}${bytes(raw.length)}${found.entry.mode === "100755" ? " · executable" : ""}${found.entry.mode === "120000" ? " · symlink" : ""}`;
    let content: string;
    if (found.entry.mode === "120000") content = `<div class="pad">Symbolic link to <code>${esc(t ?? "")}</code></div>`;
    else if (t === null) content = `<div class="pad muted">Binary file not shown.</div>`;
    else if (md) content = `<div class="markdown">${markdown(t, (href) => linkFor(b, e, path.split("/").slice(0, -1).join("/"), href))}</div>`;
    else {
      const lines = t.split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const shown = lines.slice(0, MAX_BLOB_LINES);
      content = `<table class="code">${shown.map((l, i) => `<tr id="L${i + 1}"><td class="ln"><a href="#L${i + 1}">${i + 1}</a></td><td class="lc">${esc(l) || " "}</td></tr>`).join("")}</table>${lines.length > shown.length ? `<div class="pad muted">${lines.length - shown.length} more lines; use Raw.</div>` : ""}`;
    }
    return page(path, `${head}<div class="box"><div class="boxhead">${commitLine(b, e)}</div></div><div class="box"><div class="boxhead"><span class="muted">${info}</span>${tools}</div>${content}</div>`, b);
  }

  async function commits(b: Branch, pageNo: number): Promise<ViewResponse> {
    const newest = [...b.entries].reverse();
    const pages = Math.max(1, Math.ceil(newest.length / PAGE));
    const p = Math.min(Math.max(1, pageNo), pages);
    const slice = newest.slice((p - 1) * PAGE, p * PAGE);
    const grants = new Map((b.result.code?.grants ?? []).map((g) => [g.versionId, g]));
    const historic = new Set((b.result.code?.historicallyAuthorizedOnly ?? []).map((h) => h.versionId));
    const failure = b.result.code?.history.failure;
    const rows: string[] = [];
    let day = "";
    for (const e of slice) {
      const d = e.time.slice(0, 10);
      if (d !== day) {
        rows.push(`<div class="day">Commits on ${esc(d)}</div>`);
        day = d;
      }
      const parent = e.index > 0 ? b.entries[e.index - 1] : null;
      const sameCommit = parent && parent.code?.commit === e.code?.commit;
      const touched = sameCommit ? [] : await diffTrees(parent?.root ?? null, e.root, objects).catch(() => null);
      const g = grants.get(e.versionId);
      const flags = [
        e.index === 0 ? `<span class="pill">genesis</span>` : "",
        sameCommit ? `<span class="pill">no content change</span>` : "",
        g ? `<span class="pill ${tone(g.status)}">${esc(g.status === "allowed" ? "within path grant" : g.status)}</span>` : "",
        historic.has(e.versionId) ? `<span class="pill warn" title="allowed by the repo version it names, not by the latest one (P7.9 by analogy)">historically authorized only</span>` : "",
        failure && failure.versionId === e.versionId ? `<span class="pill bad" title="${esc(failure.message)}">${esc(failure.code)}</span>` : "",
      ].join("");
      const subject = sameCommit ? null : (await commitInfo(b, e))?.message.split("\n")[0];
      rows.push(`<div class="crow"><div class="cmain"><a class="ctitle" href="/b/${b.index}/v/${encodeURIComponent(e.versionId)}">${esc(subject || e.code?.commit || e.versionId)}</a> ${flags}<div class="muted small">${did(e.signer.did)} ${e.signer.role === "editor" ? "(editor)" : `(author${delegateOf(e.signer.did) ? `, ${delegateOf(e.signer.did)}` : ""})`} · ${esc(e.time.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC"))}${touched ? ` · ${touched.length} file${touched.length === 1 ? "" : "s"} changed` : ""}</div></div><div class="cside"><a class="btn sm mono" href="/b/${b.index}/v/${encodeURIComponent(e.versionId)}">${esc(short(e.code?.commit ?? ""))}</a><a class="btn sm" title="Browse files at this commit" href="/b/${b.index}/tree/${encodeURIComponent(e.versionId)}">&lt;&gt;</a></div></div>`);
    }
    const nav = `<div class="pager">${p > 1 ? `<a class="btn" href="?page=${p - 1}">← Newer</a>` : `<span class="btn disabled">← Newer</span>`}<span class="muted">Page ${p} of ${pages}</span>${p < pages ? `<a class="btn" href="?page=${p + 1}">Older →</a>` : `<span class="btn disabled">Older →</span>`}</div>`;
    return page("Commits", `<div class="bar">${branchSwitcher(b, (x) => `/b/${x.index}/commits`)}<span class="grow"></span></div>${branchBadges(b)}<p class="muted small">One signed entry per first-parent commit, newest first. Times are the signer's claim: unanchored ordering is not proven (P9.8).</p><div class="box">${rows.join("")}</div>${nav}`, b);
  }

  async function commit(b: Branch, e: Entry): Promise<ViewResponse> {
    const parent = e.index > 0 ? b.entries[e.index - 1] : null;
    const touched = await diffTrees(parent?.root ?? null, e.root, objects);
    const before = parent ? await flatMap(parent.root) : new Map<string, TreeEntry>();
    const after = await flatMap(e.root);
    let budget = MAX_DIFF_BYTES;
    let adds = 0;
    let dels = 0;
    const files: string[] = [];
    for (const path of touched.slice(0, MAX_DIFF_FILES)) {
      const a = before.get(path);
      const z = after.get(path);
      const kind = !a ? "added" : !z ? "deleted" : a.digest === z.digest ? "mode changed" : "modified";
      const ab = a && a.digest !== z?.digest ? await objects(a.digest) : undefined;
      const zb = z && z.digest !== a?.digest ? await objects(z.digest) : undefined;
      const at = ab ? text(ab) : a && a.digest === z?.digest ? "" : null;
      const zt = zb ? text(zb) : z && z.digest === a?.digest ? "" : null;
      let body: string;
      if ((a && !ab && a.digest !== z?.digest) || (z && !zb && z.digest !== a?.digest)) body = `<div class="pad muted">The bundle does not carry these bytes.</div>`;
      else if ((a && at === null) || (z && zt === null)) body = `<div class="pad muted">Binary file not shown.</div>`;
      else if (kind === "mode changed") body = `<div class="pad muted">Mode ${esc(a!.mode)} → ${esc(z!.mode)}</div>`;
      else if ((ab?.length ?? 0) + (zb?.length ?? 0) > budget) body = `<div class="pad muted">Large diff not rendered.</div>`;
      else {
        budget -= (ab?.length ?? 0) + (zb?.length ?? 0);
        const d = renderDiff(a ? (at ?? "") : null, z ? (zt ?? "") : null);
        adds += d.adds;
        dels += d.dels;
        body = d.html;
      }
      files.push(`<div class="box file" id="${esc(path)}"><div class="boxhead"><span class="pill ${kind === "added" ? "good" : kind === "deleted" ? "bad" : "muted"}">${kind}</span> <a class="mono" href="/b/${b.index}/blob/${encodeURIComponent((z ? e : parent!).versionId)}/${pathUrl(path)}">${esc(path)}</a></div>${body}</div>`);
    }
    const more = touched.length > MAX_DIFF_FILES ? `<div class="box empty">${touched.length - MAX_DIFF_FILES} more files changed.</div>` : "";
    const g = b.result.code?.grants.find((x) => x.versionId === e.versionId);
    const info = await commitInfo(b, e);
    const cs = commitStatus(b, e, info);
    const message = info ? `<pre class="message">${esc(info.message)}</pre>` : "";
    const meta = `<div class="box commitbox"><div class="pad"><h2 class="mono">${esc(e.code?.commit ?? "(no commit)")}</h2>${message}<dl>
${info?.author ? `<dt>git author</dt><dd>${esc(info.author)} <span class="muted">(from the commit object)</span></dd>` : ""}
<dt>Commit id</dt><dd>${badge("", cs, tone(cs))} ${cs === "matches" ? "recomputed from the mirrored commit object" : cs === "claimed" ? "claimed by the signer: no commit object is mirrored" : ""}</dd>
<dt>Signed by</dt><dd>${did(e.signer.did)} as ${e.signer.role}${delegateOf(e.signer.did) ? ` (${delegateOf(e.signer.did)})` : ""}</dd>
<dt>versionTime</dt><dd>${esc(e.time)} <span class="muted">(claimed by the signer)</span></dd>
<dt>Entry</dt><dd><code>${esc(e.versionId)}</code> of ${did(b.original)}</dd>
<dt>git tree</dt><dd><code>${esc(e.code?.tree ?? "")}</code> ${badge("", b.result.code?.gitBinding.mismatches.some((m) => m.versionId === e.versionId) ? "mismatch" : (b.result.code?.gitBinding.status ?? "unchecked"), tone(b.result.code?.gitBinding.mismatches.some((m) => m.versionId === e.versionId) ? "mismatch" : b.result.code?.gitBinding.status))}</dd>
<dt>Repo version</dt><dd><code>${esc(e.code?.repoVersion ?? "")}</code></dd>
${g ? `<dt>Path grant</dt><dd>${badge("", g.status, tone(g.status))} ${g.outside ? `outside: ${g.outside.map((p) => `<code>${esc(p)}</code>`).join(" ")}` : ""}</dd>` : ""}
<dt>Parent</dt><dd>${parent ? `<a class="mono" href="/b/${b.index}/v/${encodeURIComponent(parent.versionId)}">${esc(short(parent.code?.commit ?? parent.versionId, 10))}</a>` : "none (genesis)"}</dd>
</dl><p class="muted small">The tree is recomputed from the objects. ${info ? "The commit id, tree and first parent are recomputed from the commit object (plan 049, K12)." : "The commit id is the signer's claim (plan 049, K12)."}</p>
<a class="btn" href="/b/${b.index}/tree/${encodeURIComponent(e.versionId)}">Browse files</a></div></div>`;
    const stat = `<div class="bar"><span><b>${touched.length}</b> file${touched.length === 1 ? "" : "s"} changed</span> <span class="add">+${adds}</span> <span class="del">−${dels}</span></div>`;
    return page(short(e.code?.commit ?? e.versionId), `${meta}${stat}${files.join("")}${more}`, b);
  }

  async function flatMap(root: string): Promise<Map<string, TreeEntry>> {
    const out = new Map<string, TreeEntry>();
    async function walk(d: string, prefix: string) {
      const t = await readTree(d, objects);
      for (const [n, x] of Object.entries(t.entries)) {
        const p = prefix ? `${prefix}/${n}` : n;
        if (x.mode === "40000") await walk(x.digest, p);
        else out.set(p, x);
      }
    }
    await walk(root, "");
    return out;
  }

  function verifyPage(): ViewResponse {
    const r = report.repo;
    const rows = [
      `<tr><th colspan="2">Repo Original ${did(r.original)}</th></tr>`,
      `<tr><td>Originals history</td><td>${badge("", r.report?.history.status ?? "unread", tone(r.report?.history.status))} valid as of <code>${esc(r.report?.validAsOf?.checkpoint ?? "nothing")}</code>${r.error ? ` <span class="bad-text">${esc(r.error.code)}: ${esc(r.error.message)}</span>` : ""}</td></tr>`,
      `<tr><td>Author binding</td><td>${badge("", r.report?.authorBinding.status ?? "unknown", tone(r.report?.authorBinding.status))}</td></tr>`,
      `<tr><td>Code profile</td><td>${badge("", r.code?.history.status ?? "not checked", tone(r.code?.history.status))} ${r.code?.history.failure ? esc(`${r.code.history.failure.code}: ${r.code.history.failure.message}`) : ""}</td></tr>`,
      `<tr><td>Canonical heads</td><td>${badge("", report.canonicalStatus, tone(report.canonicalStatus))} ${report.canonical.map((c) => `${esc(c.ref)}: ${badge("", c.status, tone(c.status))} ${c.head ? `<code>${esc(c.head.commit)}</code>` : esc(c.reason ?? "")}`).join("<br>")}</td></tr>`,
      ...branches.flatMap((b) => {
        const c = b.result.code;
        return [
          `<tr><th colspan="2">Branch <a href="/b/${b.index}">${esc(b.name)}</a> ${did(b.original)}</th></tr>`,
          `<tr><td>Originals history</td><td>${badge("", b.result.report?.fork ? "forked (unresolved, P9.16)" : (b.result.report?.history.status ?? "unread"), b.result.report?.fork ? "bad" : tone(b.result.report?.history.status))} ${b.result.report?.history.entries ?? 0} entries, valid as of <code>${esc(b.result.report?.validAsOf?.checkpoint ?? "nothing")}</code></td></tr>`,
          `<tr><td>Code profile</td><td>${badge("", c?.history.status ?? "not checked", tone(c?.history.status))} ${c?.history.failure ? esc(`entry ${c.history.failure.index}: ${c.history.failure.code}: ${c.history.failure.message}`) : ""}</td></tr>`,
          `<tr><td>Listed in the repo</td><td>${badge("", c?.binding.status ?? "not checked", tone(c?.binding.status))} ${esc(c?.binding.reason ?? "")}</td></tr>`,
          `<tr><td>git tree ids</td><td>${badge("", c?.gitBinding.status ?? "unchecked", tone(c?.gitBinding.status))} ${c ? `${c.gitBinding.checked} recomputed and matched, ${c.gitBinding.unchecked} unchecked, ${c.gitBinding.mismatches.length} mismatched` : ""}</td></tr>`,
          `<tr><td>Content</td><td>${badge("", c?.content.status ?? "unknown", tone(c?.content.status))} ${c ? `${c.content.objects} objects, ${bytes(c.content.bytes)}, ${c.content.missing.length} missing, ${c.content.failures.length} failed` : ""}</td></tr>`,
          c && c.grants.length ? `<tr><td>Editor entries</td><td>${c.grants.length} checked against path grants: ${c.grants.filter((g) => g.status === "allowed").length} allowed; ${c.historicallyAuthorizedOnly.length} historically authorized only</td></tr>` : "",
        ];
      }),
    ];
    return page("Verification", `<h2>Verification</h2><p class="muted">Each result is reported separately and never merged into one verdict (section 7). Verified offline, with no key and no network. <b>Current: no</b>: nothing is anchored, so each Original is valid only as of its checkpoint (P7.10).</p><div class="box"><table class="report">${rows.join("")}</table></div><details><summary>Full report (JSON)</summary><pre class="json">${esc(JSON.stringify(report, null, 2))}</pre></details>`);
  }

  function page(title: string, body: string, b?: Branch): ViewResponse {
    return { status: 200, type: "text/html; charset=utf-8", body: layout(title, body, b) };
  }
  function notFound(): ViewResponse {
    return { status: 404, type: "text/html; charset=utf-8", body: layout("Not found", `<div class="box empty">Not found.</div>`) };
  }

  return {
    async handle(url: string): Promise<ViewResponse> {
      const u = new URL(url, "http://viewer.invalid");
      let parts: string[];
      try {
        parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        return notFound();
      }
      if (parts.length === 0) return home();
      if (parts[0] === "verify" && parts.length === 1) return verifyPage();
      if (parts[0] === "raw" && parts.length === 2) {
        const raw = await objects(parts[1]);
        if (!raw) return notFound();
        return { status: 200, type: text(raw) !== null ? "text/plain; charset=utf-8" : "application/octet-stream", body: raw };
      }
      if (parts[0] !== "b" || parts.length < 2) return notFound();
      const b = branches[Number(parts[1])];
      if (!b || !/^\d+$/.test(parts[1])) return notFound();
      const head = b.entries[b.entries.length - 1];
      if (parts.length === 2) return head ? tree(b, head, "", true) : page(b.name, `${branchBadges(b)}<div class="box empty">This branch has no verified entry.</div>`, b);
      if (parts[2] === "commits" && parts.length === 3) return commits(b, Number(u.searchParams.get("page") ?? 1) || 1);
      const e = b.entries.find((x) => x.versionId === parts[3]);
      if (!e) return notFound();
      if (parts[2] === "v" && parts.length === 4) return commit(b, e);
      if (parts[2] === "tree") return tree(b, e, parts.slice(4).join("/"));
      if (parts[2] === "blob") return blob(b, e, parts.slice(4).join("/"), u.searchParams.has("plain"));
      return notFound();
    },
  };
}

// ---- line diff (Myers, with common prefix and suffix trimmed) ----

type Op = [" " | "-" | "+", string];

function myers(a: string[], b: string[], max: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d, off);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dEnd: number, off: number): Op[] {
  const out: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push([" ", a[--x]]);
      y--;
    }
    if (x === prevX) out.push(["+", b[--y]]);
    else out.push(["-", a[--x]]);
  }
  while (x > 0 && y > 0) {
    out.push([" ", a[--x]]);
    y--;
  }
  return out.reverse();
}

function lines(t: string): string[] {
  const l = t.split("\n");
  if (l.length > 0 && l[l.length - 1] === "") l.pop();
  return l;
}

/** A unified diff, as HTML rows with old and new line numbers and three lines of context. */
export function renderDiff(before: string | null, after: string | null): { html: string; adds: number; dels: number } {
  const a = before === null ? [] : lines(before);
  const b = after === null ? [] : lines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), 4000);
  if (!mid) return { html: `<div class="pad muted">Diff too large to render.</div>`, adds: 0, dels: 0 };
  const ops: Op[] = [...a.slice(0, pre).map((l): Op => [" ", l]), ...mid, ...a.slice(a.length - suf).map((l): Op => [" ", l])];
  const C = 3;
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, i) => {
    if (o[0] !== " ") for (let j = Math.max(0, i - C); j <= Math.min(ops.length - 1, i + C); j++) keep[j] = 1;
  });
  let ai = 0;
  let bi = 0;
  let adds = 0;
  let dels = 0;
  const rows: string[] = [];
  let gap = false;
  ops.forEach((o, i) => {
    const [t, l] = o;
    if (t !== "+") ai++;
    if (t !== "-") bi++;
    if (t === "+") adds++;
    if (t === "-") dels++;
    if (!keep[i]) {
      gap = true;
      return;
    }
    if (gap || rows.length === 0) {
      rows.push(`<tr class="hunk"><td class="ln"></td><td class="ln"></td><td class="lc">@@ ${t === "+" ? ai + 1 : ai} · ${t === "-" ? bi + 1 : bi} @@</td></tr>`);
      gap = false;
    }
    const cls = t === "+" ? "add" : t === "-" ? "del" : "";
    rows.push(`<tr class="${cls}"><td class="ln">${t === "+" ? "" : ai}</td><td class="ln">${t === "-" ? "" : bi}</td><td class="lc">${esc(`${t === " " ? " " : t}${l}`)}</td></tr>`);
  });
  return { html: rows.length ? `<table class="diff">${rows.join("")}</table>` : `<div class="pad muted">No line changes.</div>`, adds, dels };
}

// ---- a small Markdown renderer (headings, lists, quotes, code, tables, inline marks) ----

export function markdown(src: string, link: (href: string) => string | null): string {
  const inline = (s: string): string => {
    const codes: string[] = [];
    let t = s.replace(/`([^`]+)`/g, (_, c: string) => `\uE000${codes.push(`<code>${esc(c)}</code>`) - 1}\uE001`);
    t = esc(t);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt: string) => `<span class="muted">[${alt || "image"}]</span>`);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label: string, href: string) => {
      const target = link(href.replace(/&amp;/g, "&"));
      return target ? `<a href="${esc(target)}">${label}</a>` : label;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>");
    return t.replace(/\uE000(\d+)\uE001/g, (_, i: string) => codes[Number(i)]);
  };
  const out: string[] = [];
  const src2 = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  while (i < src2.length) {
    const line = src2[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < src2.length && !src2[i].trimStart().startsWith(fence[1])) body.push(src2[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < src2.length && /^\s*\|?\s*:?-{2,}/.test(src2[i + 1])) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < src2.length && /^\s*\|/.test(src2[i])) body.push(cells(src2[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < src2.length && /^\s*>/.test(src2[i])) body.push(src2[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdown(body.join("\n"), link)}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      while (i < src2.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(src2[i]);
        if (m) {
          items.push(m[1].length >= 2 && items.length ? `${items.pop()}<br>${inline(m[3])}` : inline(m[3]));
          i++;
        } else if (/^\s{2,}\S/.test(src2[i]) && items.length) {
          items.push(`${items.pop()} ${inline(src2[i].trim())}`);
          i++;
        } else break;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${x}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    if (/^\s*</.test(line)) {
      // Raw HTML is never passed through; show it as text.
      para.push(line.trim());
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join("\n");
}

const CSS = `
:root{--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--bg:#fff;--subtle:#f6f8fa;--accent:#0969da;--good:#1a7f37;--bad:#d1242f;--warn:#9a6700;--addbg:#dafbe1;--delbg:#ffebe9;--hunk:#ddf4ff}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--bg:#0d1117;--subtle:#151b23;--accent:#4493f8;--good:#3fb950;--bad:#f85149;--warn:#d29922;--addbg:#12261e;--delbg:#25171c;--hunk:#121d2f}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,.mono,pre{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12px}
.wrap{max-width:1280px;margin:0 auto;padding:0 24px}
.top{background:#1f2328;color:#fff;padding:12px 24px;display:flex;align-items:center;gap:16px}.top .logo{color:#fff;font-weight:600;font-size:16px}.top .logo span{opacity:.6;margin-left:4px}.repo-did{color:#9198a1;font-family:ui-monospace,monospace;font-size:12px}
.repohead{background:var(--subtle);border-bottom:1px solid var(--border);padding-top:16px}.repohead h1{font-size:20px;font-weight:400;margin:0 0 12px;display:flex;align-items:center;gap:10px}.repohead h1 a{font-weight:600}
.tabs{display:flex;gap:4px}.tabs a{color:var(--fg);padding:8px 14px;border-bottom:2px solid transparent}.tabs a:hover{border-color:var(--border);text-decoration:none}.count{background:var(--border);border-radius:10px;padding:0 6px;font-size:12px}
main{padding:24px 0}footer{color:var(--muted);font-size:12px;padding:24px;border-top:1px solid var(--border)}
.cols{display:grid;grid-template-columns:minmax(0,1fr) 296px;gap:24px}@media(max-width:900px){.cols{grid-template-columns:1fr}}
.box{border:1px solid var(--border);border-radius:6px;margin-bottom:16px;overflow:hidden;background:var(--bg)}.boxhead{background:var(--subtle);padding:8px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap}.box>.boxhead:last-child{border-bottom:0}
.empty,.pad{padding:16px}.muted{color:var(--muted)}.small{font-size:12px}.grow{flex:1}
.bar{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border);background:var(--subtle);color:var(--fg);border-radius:6px;padding:5px 12px;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}.btn:hover{text-decoration:none;filter:brightness(.97)}.btn.sm{padding:2px 8px;font-size:12px}.btn.disabled{opacity:.5}
.switch{position:relative}.switch summary{list-style:none}.switch summary::-webkit-details-marker{display:none}.switch small{color:var(--muted);font-weight:400}.menu{position:absolute;z-index:5;top:34px;left:0;min-width:280px;background:var(--bg);border:1px solid var(--border);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.15)}.menu a{display:block;padding:8px 12px;color:var(--fg);border-bottom:1px solid var(--border)}.menu a.on{font-weight:600}.menu small{color:var(--muted)}
.crumbs{font-size:16px}.crumbs b{font-weight:600}
table{border-collapse:collapse;width:100%}.files td{padding:7px 16px;border-top:1px solid var(--border)}.files tr:first-child td{border-top:0}.files .icon{width:28px;padding-right:0}.files tr:hover{background:var(--subtle)}
.commitline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1}.sha{font-family:ui-monospace,monospace;font-size:12px}.role{border:1px solid var(--border);border-radius:10px;padding:0 6px;font-size:11px}
.badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.badge{display:inline-flex;border-radius:4px;overflow:hidden;font-size:11px;border:1px solid currentColor;padding:1px 6px;gap:0}.badge b{font-weight:400;opacity:.8}.badge.good{color:var(--good)}.badge.bad{color:var(--bad)}.badge.warn{color:var(--warn)}.badge.muted{color:var(--muted)}
.pill{font-size:11px;border:1px solid var(--border);border-radius:10px;padding:0 7px;color:var(--muted)}.pill.good{color:var(--good);border-color:var(--good)}.pill.bad{color:var(--bad);border-color:var(--bad)}.pill.warn{color:var(--warn);border-color:var(--warn)}
.about h3{margin:0 0 8px;font-size:16px}.about h4{margin:20px 0 6px;font-size:14px}.plain{list-style:none;margin:0;padding:0}.plain li{padding:3px 0}
.note{background:var(--hunk);border:1px solid var(--border);border-radius:6px;padding:8px 16px;margin-bottom:12px}
.readme .markdown{padding:16px 32px}.markdown{font-size:15px;line-height:1.6;overflow-wrap:anywhere}.markdown h1,.markdown h2{border-bottom:1px solid var(--border);padding-bottom:.3em}.markdown pre{background:var(--subtle);padding:16px;border-radius:6px;overflow:auto}.markdown code{background:var(--subtle);padding:.2em .4em;border-radius:4px}.markdown pre code{background:none;padding:0}.markdown table{width:auto;margin:12px 0}.markdown th,.markdown td{border:1px solid var(--border);padding:6px 12px}.markdown blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--border)}
.code td,.diff td{padding:0 10px;vertical-align:top}.code .ln,.diff .ln{width:1%;min-width:50px;text-align:right;color:var(--muted);user-select:none;font-family:ui-monospace,monospace;font-size:12px}.code .ln a{color:var(--muted)}.lc{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:20px}.code tr:target{background:var(--hunk)}
.diff tr.add{background:var(--addbg)}.diff tr.del{background:var(--delbg)}.diff tr.hunk{background:var(--hunk);color:var(--muted)}.add{color:var(--good);font-weight:600}.del{color:var(--bad);font-weight:600}.diff tr.add .lc,.diff tr.del .lc{font-weight:400;color:var(--fg)}
.day{padding:8px 16px;background:var(--subtle);border-top:1px solid var(--border);color:var(--muted);font-size:13px}.day:first-child{border-top:0}
.crow{display:flex;gap:12px;padding:10px 16px;border-top:1px solid var(--border);align-items:center}.cmain{flex:1;min-width:0}.ctitle{font-weight:600;color:var(--fg);font-family:ui-monospace,monospace;font-size:13px}.cside{display:flex;gap:6px}
.pager{display:flex;justify-content:center;align-items:center;gap:16px}
.commitbox h2{margin:0 0 12px;font-size:18px;word-break:break-all}.commitbox .message{white-space:pre-wrap;margin:0 0 12px;font-size:13px}dl{display:grid;grid-template-columns:140px 1fr;gap:6px 12px;margin:0 0 12px}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
.report td,.report th{padding:8px 16px;border-top:1px solid var(--border);text-align:left;vertical-align:top}.report th{background:var(--subtle);font-weight:600}.report td:first-child{width:200px;color:var(--muted)}.bad-text{color:var(--bad)}
.json{background:var(--subtle);padding:16px;border-radius:6px;overflow:auto;max-height:600px}details>summary{cursor:pointer;margin:8px 0}
.did{background:none}
`;
