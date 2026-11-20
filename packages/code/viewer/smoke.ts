/**
 * Browser smoke test of the built static viewer (plan 049 §6 milestone 1):
 * serve `viewer/dist` and a split bundle of a fixture repository under a path
 * prefix, as GitHub Pages does, load it in headless Chromium and require:
 * the bundle verifies in the page; files open by digest and show as loaded;
 * repository content never runs as markup; no Content Security Policy
 * violation, page error or console error.
 *
 *   bun viewer/build.ts && bun viewer/smoke.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { chromium } from "playwright-core";
import { GitSource } from "../src/git.js";
import { splitBundle } from "../src/index.js";
import { FixtureRepo, identity, workspace } from "../tests/helpers.js";

const PREFIX = "/sdk/code/";
const dist = join(import.meta.dir, "dist");
const site = mkdtempSync(join(tmpdir(), "originals-code-viewer-"));
const up = new FixtureRepo();

function fail(message: string): never {
  console.error(`[viewer smoke] FAILED: ${message}`);
  process.exit(1);
}

// A repository shaped like the dogfood mirror: the owner authors the branch, CI appends as an editor with a `**` grant.
const owner = await identity(1);
const ci = await identity(5);
const ws = workspace(() => Date.now());
ws.addIdentity(ci);
up.commit({ "README.md": "# Smoke\n\nSee [the guide](docs/guide.md).\n\n<script>window.__xss = 1</script>\n<img src=x onerror=\"window.__xss=2\">\n", "docs/guide.md": "guide\n", "src/a.ts": "export const a = 1;\n" });
const s1 = new GitSource(up.dir);
const repo = await ws.initRepo({ name: "smoke", identity: owner });
const { branch } = await ws.mirror({ repo, ref: "refs/heads/main", identity: owner, source: s1 });
s1.close();
await ws.grantPaths(repo, owner, ci.did, ["**"]);
up.commit({ "src/a.ts": "export const a = 2;\n", "src/<b>.ts": "x\n" });
const s2 = new GitSource(up.dir);
await ws.mirror({ repo, ref: "refs/heads/main", identity: ci, source: s2, branch });
s2.close();
const files = await splitBundle(await ws.package(repo));
for (const [name, bytes] of files) {
  const path = join(site, "bundle", ...name.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
const looseCount = (JSON.parse(new TextDecoder().decode(files.get("objects/loose.json"))) as unknown[]).length;

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (!path.startsWith(PREFIX)) return new Response("not found", { status: 404 });
    const rel = normalize(path.slice(PREFIX.length) || "index.html");
    if (rel.startsWith("..")) return new Response("not found", { status: 404 });
    const root = rel.startsWith("bundle/") ? site : dist;
    try {
      const body = await readFile(join(root, rel.endsWith("/") ? `${rel}index.html` : rel));
      const ext = /\.[a-z]+$/.exec(rel)?.[0] ?? "";
      return new Response(body, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
});

const url = `http://127.0.0.1:${server.port}${PREFIX}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || /Content Security Policy/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("table.files", { timeout: 30_000 });
  const status = await page.textContent("#status");
  if (!status?.includes("verified in this browser")) fail(`the repo is not shown verified: ${status}`);
  if (!status.includes(`not loaded (not verified)`)) fail(`not-loaded files are not reported: ${status}`);
  const readme = await page.innerHTML(".readme");
  if (!readme.includes("&lt;script&gt;")) fail("the README's markup is not shown as text");
  if (await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)) fail("repository content ran as script");

  // Open a file: fetched by digest, checked, shown; the count goes up.
  await page.click('table.files a:text("src")');
  await page.waitForSelector('table.files a:text("a.ts")');
  await page.click('table.files a:text("a.ts")');
  await page.waitForSelector("table.code");
  const code = await page.textContent("table.code");
  if (!code?.includes("export const a = 2;")) fail(`the file's content is wrong: ${code}`);
  if (!page.url().includes("#/b/0/blob/")) fail(`routing is not in the hash: ${page.url()}`);
  if (!new URL(page.url()).pathname.startsWith(PREFIX)) fail("the page left its path prefix");
  await page.waitForFunction(() => /\b[1-9]\d* of \d+ loaded and checked/.test(document.getElementById("status")?.textContent ?? ""));

  // The commits page and the verification page route in the hash, under the prefix.
  await page.click('nav.tabs a:text("Commits")');
  await page.waitForSelector(".crow");
  if ((await page.$$(".crow")).length !== 2) fail("the commits page does not list both entries");
  const commits = (await page.textContent("main")) ?? "";
  if (!commits.includes("inherited path grant")) fail("the CI editor's entry is not shown under its inherited path grant");
  if (!commits.includes("commit 1") || !commits.includes("commit 0")) fail("the commit message (from the mirrored commit object, K12) is not shown");
  await page.click('nav.tabs a:text("Verification")');
  await page.waitForSelector("table.report");
  const verification = (await page.textContent("table.report")) ?? "";
  for (const want of ["Signer set", "1 of 1 delegates sign each repo change", "Pins", "inherited path grants"]) {
    if (!verification.includes(want)) fail(`the verification page does not show ${JSON.stringify(want)}`);
  }

  // Fetch everything: the full content check passes.
  await page.click('button:text("Fetch and check every file")');
  await page.waitForFunction((n) => (document.getElementById("status")?.textContent ?? "").includes(`${n} of ${n} loaded and checked`), looseCount, { timeout: 30_000 });
  await page.waitForSelector("table.report");
  const report = await page.textContent("table.report");
  if (!report?.includes("complete")) fail("content is not complete after fetching every file");

  // A bundle that is not there: the picker, with the reason.
  await page.goto(`${url}?bundle=missing/`, { waitUntil: "load" });
  await page.waitForSelector('input[type="file"]');
} finally {
  await browser.close();
  server.stop(true);
  up.remove();
  rmSync(site, { recursive: true, force: true });
}
// The deliberately missing bundle 404s; that is the one expected failure.
const unexpected = errors.filter((e) => !/missing\/originals-code\.json|404/.test(e));
if (unexpected.length) fail(unexpected.join("\n"));
console.log(`[viewer smoke] ${url}: verified, ${looseCount} files fetched by digest and checked, no CSP violation or error`);
