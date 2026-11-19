/**
 * The repository viewer (plan 049, K11; CODE-18): a read-only, GitHub-like
 * view of a verified bundle. It shows only verified entries, reports the
 * verification results separately, never claims anything current (P7.10),
 * and never passes repository content through as markup.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GitSource } from "../src/git.js";
import { openRepository } from "../src/index.js";
import { createRepositoryView, markdown, renderDiff } from "../src/view.js";
import { FixtureRepo, NOW, identity, workspace } from "./helpers.js";

const MAIN = "refs/heads/main";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

async function viewer() {
  const alice = await identity(1);
  const ws = workspace();
  const up = new FixtureRepo();
  cleanup.push(() => up.remove());
  const c1 = up.commit({ "README.md": "# Hello\n\nSee [the guide](docs/guide.md) and [x](javascript:alert(1)).\n\n<script>alert(1)</script>\n", "docs/guide.md": "guide", "src/a.ts": "one\ntwo\nthree\n" });
  const c2 = up.commit({ "src/a.ts": "one\nTWO\nthree\n", "src/<b>.ts": "x", "docs/guide.md": null });
  const s = new GitSource(up.dir);
  cleanup.push(() => s.close());
  const repo = await ws.initRepo({ name: "demo", identity: alice });
  await ws.mirror({ repo, ref: MAIN, identity: alice, source: s });
  const opened = await openRepository(await ws.package(repo), { now: NOW + 3_600_000 });
  const branch = opened.report.branches[0].original;
  const entries = opened.entries.get(branch)!;
  const view = createRepositoryView(opened);
  const get = async (url: string) => {
    const r = await view.handle(url);
    return { ...r, html: typeof r.body === "string" ? r.body : new TextDecoder().decode(r.body) };
  };
  return { get, c1, c2, entries, opened };
}

describe("CODE-18 the repository viewer", () => {
  test("home shows the canonical head's files, the README and the verification results", async () => {
    const { get, c2 } = await viewer();
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.html).toContain(">demo</a>");
    expect(r.html).toContain(">src</a>");
    expect(r.html).toContain("<h1>Hello</h1>");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("javascript:");
    expect(r.html).toContain(`>${c2.slice(0, 7)}</a>`);
    expect(r.html).toContain("canonical </b>agreed");
    expect(r.html).toContain("never current (P7.10)");
  });

  test("commits list every verified entry, newest first, with files changed", async () => {
    const { get, c1, c2 } = await viewer();
    const r = await get("/b/0/commits");
    expect(r.status).toBe(200);
    expect(r.html.indexOf(`>${c2.slice(0, 7)}<`)).toBeGreaterThan(-1);
    expect(r.html.indexOf(`>${c2.slice(0, 7)}<`)).toBeLessThan(r.html.indexOf(`>${c1.slice(0, 7)}<`));
    expect(r.html).toContain("3 files changed");
    expect(r.html).toContain("genesis");
  });

  test("a commit page shows a line diff against its parent entry", async () => {
    const { get, entries } = await viewer();
    const r = await get(`/b/0/v/${entries[1].versionId}`);
    expect(r.status).toBe(200);
    expect(r.html).toContain('<tr class="del"><td class="ln">2</td><td class="ln"></td><td class="lc">-two</td></tr>');
    expect(r.html).toContain('<tr class="add"><td class="ln"></td><td class="ln">2</td><td class="lc">+TWO</td></tr>');
    expect(r.html).toContain(">deleted</span>");
    expect(r.html).toContain(">added</span>");
  });

  test("CODE-19 a commit whose id was recomputed from its commit object shows its message as text", async () => {
    const { get, c2, entries } = await viewer();
    const list = await get("/b/0/commits");
    expect(list.html).toContain(">commit 1</a>"); // the subject from the commit object
    const r = await get(`/b/0/v/${encodeURIComponent(entries[1].versionId)}`);
    expect(r.html).toContain(c2);
    expect(r.html).toContain(`<pre class="message">commit 1</pre>`);
    expect(r.html).toContain("Fixture &lt;fixture@example.invalid&gt;");
    expect(r.html).toContain("recomputed from the mirrored commit object");
  });

  test("trees and files at an earlier entry; raw bytes by digest", async () => {
    const { get, entries } = await viewer();
    const old = await get(`/b/0/blob/${entries[0].versionId}/docs/guide.md`);
    expect(old.status).toBe(200);
    expect(old.html).toContain("<p>guide</p>");
    expect((await get(`/b/0/blob/${entries[1].versionId}/docs/guide.md`)).status).toBe(404);
    const file = await get(`/b/0/blob/${entries[1].versionId}/src/a.ts`);
    expect(file.html).toContain('<td class="lc">TWO</td>');
    const digest = /href="\/raw\/([^"]+)"/.exec(file.html)![1];
    const raw = await get(`/raw/${digest}`);
    expect(raw).toMatchObject({ status: 200, type: "text/plain; charset=utf-8", html: "one\nTWO\nthree\n" });
    expect((await get(`/b/0/tree/${entries[0].versionId}/docs`)).html).toContain(">guide.md</a>");
    const src = await get(`/b/0/tree/${entries[1].versionId}/src`);
    expect(src.html).toContain(">&lt;b&gt;.ts</a>"); // a file name is text, never markup
    expect(src.html).not.toContain("<b>.ts");
  });

  test("unknown routes, branches, entries and paths are 404", async () => {
    const { get, entries } = await viewer();
    for (const url of ["/nope", "/b/9", "/b/x", "/b/0/v/1-zzz", `/b/0/tree/${entries[1].versionId}/missing`, `/b/0/blob/${entries[1].versionId}/../../etc/passwd`, "/raw/zNotADigest"]) {
      expect((await get(url)).status).toBe(404);
    }
  });

  test("the verification page reports each result separately, with the full report", async () => {
    const { get } = await viewer();
    const r = await get("/verify");
    expect(r.html).toContain("Originals history");
    expect(r.html).toContain("git tree ids");
    expect(r.html).toContain("<b>Current: no</b>");
    expect(r.html).toContain("&quot;current&quot;: false");
  });
});

describe("renderDiff and markdown", () => {
  test("a minimal diff with context and hunks", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l3", "L3").replace("l17", "L17");
    const d = renderDiff(before, after);
    expect(d).toMatchObject({ adds: 2, dels: 2 });
    expect(d.html.match(/class="hunk"/g)).toHaveLength(2);
    expect(renderDiff(null, "a\nb\n")).toMatchObject({ adds: 2, dels: 0 });
    expect(renderDiff("a\n", null)).toMatchObject({ adds: 0, dels: 1 });
  });

  test("markdown escapes everything and keeps only safe links", () => {
    const html = markdown('**b** `<i>` [ok](https://x.example) [bad](javascript:alert`1`) [rel](a/b.md)\n\n```\n<tag>\n```', (h) => (h.startsWith("https:") ? h : h.startsWith("javascript:") ? null : `/x/${h}`));
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<code>&lt;i&gt;</code>");
    expect(html).toContain('<a href="https://x.example">ok</a>');
    expect(html).toContain(" bad ");
    expect(html).toContain('<a href="/x/a/b.md">rel</a>');
    expect(html).toContain("<pre><code>&lt;tag&gt;</code></pre>");
  });
});
