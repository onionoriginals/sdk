/**
 * The staging B run's author clients (Node + playwright-core, one process per
 * action). Each client is Chromium on a persistent user-data dir, so a
 * "restart" closes the browser process and launches a new one on the same
 * profile: IndexedDB, localStorage and cookies survive as they do for a
 * person. "Another client" is a second, empty profile.
 *
 * The page's own engine (`window.__originalsDemo`, which Demo exposes only on
 * a staging acceptance build: the switch set, not the production host, not
 * mainnet; src/sdk/acceptance-hook.ts) is
 * driven through its public methods, so every signature is made by the real
 * client-held Turnkey session in that page. Sign-in goes through the UI; the
 * OTP is read from the operator on stdin, typed into the page, and dropped.
 * It never reaches a file, a log or the receipt.
 *
 * Input (ACCEPTANCE_INPUT): { action, baseUrl, email?, profile, prior?, productionUrl? }.
 * NOT YET EXERCISED against a deployed host: the first staging run is its
 * test (scripts/acceptance/hosted-README.md).
 */
import { didWebvhDomain } from "./did-domain.mjs";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright-core";
import { safeFetch } from "@originals/vh/fetch";
import { didWebvhLogUrl } from "@originals/vh/webvh";
import { readEvidence } from "@originals/sdk/originals";
import { chromiumExecutablePath } from "../../../apps/landing/scripts/browser.mjs";
import { assert, assertEqual, Phase, sha256Hex } from "../lib/phase.mjs";

const phase = new Phase(`browser-${JSON.parse(process.env.ACCEPTANCE_INPUT).action}`);
const input = phase.input;
const base = input.baseUrl.replace(/\/$/, "");
phase.facts.manual = [];

// A real PNG (1x1) and a second one with a different pixel, so the revision changes bytes.
const PNG_A = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5c8a26f0000000049454e44ae426082";
const PNG_B = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63606060f80f0001040100c39e6a2b0000000049454e44ae426082";

/** A persistent profile (a client), or a fresh incognito context whose browser closes with it. */
async function launch(profile) {
  if (profile) return chromium.launchPersistentContext(profile, { executablePath: chromiumExecutablePath(), acceptDownloads: true });
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath() });
  const ctx = await browser.newContext();
  const close = ctx.close.bind(ctx);
  ctx.close = async () => {
    await close();
    await browser.close();
  };
  return ctx;
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Sign in through the page's own modal; the operator types the OTP. */
async function signIn(page) {
  const signedIn = await page.evaluate(() => fetch("/api/me", { credentials: "same-origin" }).then((r) => r.ok));
  if (signedIn) return false;
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.locator("input.login-email").fill(input.email);
  await page.locator("form.login-form button[type=submit]").click();
  const code = await ask(`[${phase.name}] OTP sent to the test inbox. Enter it: `);
  assert(/^\d{6}$/.test(code), "the OTP is six digits");
  const digits = page.locator("input.otp-digit");
  for (let i = 0; i < 6; i++) await digits.nth(i).fill(code[i]);
  await page.locator("input.login-email, input.otp-digit").first().waitFor({ state: "detached", timeout: 60_000 });
  phase.facts.manual.push({ step: "otp", phase: phase.name, at: new Date().toISOString() });
  return true;
}

/** The demo's engine for the signed-in account, once it exists. */
async function engineReady(page, authed = true) {
  await page.evaluate(() => document.getElementById("demo")?.scrollIntoView());
  await page.waitForFunction((want) => globalThis.__originalsDemo && globalThis.__originalsDemo.authed === want, authed, { timeout: 60_000 });
}

/**
 * The account library as a person sees it: main's /me page (#992, #996). Each
 * row (`LibraryEntry`) is a link for a real DID (an `unknown:` record is
 * plain text), its labels ("In this browser", "Saved to account", ...) in the
 * first <p>, the DID in <small>, and any problem (a fork, a divergence,
 * unreadable evidence) in a later <p>. Returns to the demo afterwards, with
 * its engine ready.
 */
async function libraryRows(page, authed = true) {
  await page.goto(`${base.replace(/\/$/, "")}/me`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".originals-library") && !/Reading your saved work/.test(document.body.textContent ?? ""), null, { timeout: 60_000 });
  const rows = await page.$$eval(".library-list li", (lis) => lis.map((li) => {
    const ps = [...li.querySelectorAll("p")].map((p) => p.textContent ?? "");
    return { did: li.querySelector("small")?.textContent ?? "", labels: ps[0] ?? "", problem: ps.slice(1).join(" ") || null, openable: !!li.querySelector("a") };
  }));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await engineReady(page, authed);
  return rows;
}

async function ensureIdentity(page) {
  const cta = page.locator("button.idp-cta");
  if (await cta.count()) {
    await cta.click();
    await cta.waitFor({ state: "detached", timeout: 120_000 });
  }
}

const call = (page, method, ...args) =>
  page.evaluate(
    async ([m, a]) => {
      const revive = (v) => (v && v.__bytes ? Uint8Array.from(v.__bytes) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)])) : v);
      try {
        const out = await globalThis.__originalsDemo[m](...a.map(revive));
        return { ok: true, value: out instanceof Uint8Array ? { __bytes: [...out] } : JSON.parse(JSON.stringify(out, (_k, x) => (x instanceof Uint8Array ? { __bytes: [...x] } : x))) };
      } catch (e) {
        return { ok: false, name: e?.name, message: String(e?.message ?? e) };
      }
    },
    [method, args],
  );
const must = async (page, method, ...args) => {
  const r = await call(page, method, ...args);
  assert(r.ok, `${method} failed`, r);
  return r.value;
};
const png = (hex) => ({ content: { __bytes: [...Buffer.from(hex, "hex")] }, contentType: "image/png", filename: "work.png" });
const resourcesOf = (s) => [{ id: s.resource.id, mediaType: s.resource.contentType, sha256: s.resource.hash }, ...(s.metadata ? [{ id: s.metadata.id, mediaType: "application/json", sha256: s.metadata.hash }] : [])];
const facts = (s) => ({ did: s.did, alias: s.webvhDid, checkpoint: s.history.at(-1).versionId, entries: s.history.length, resources: resourcesOf(s) });
const text = async (url) => new TextDecoder().decode((await safeFetch(url)).bytes);
const jsonl = (t) => t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** Abort uploads matching `match` (the decoded host key) in this page. */
async function interruptUploads(page, match) {
  await page.route("**/api/originals/host/**", (route) => {
    const key = decodeURIComponent(new URL(route.request().url()).pathname.slice("/api/originals/host/".length));
    return route.request().method() === "PUT" && match(key) ? route.abort("connectionreset") : route.continue();
  });
}

const actions = {
  /** B1 and the B4 setup, in client A. */
  async "client-a"() {
    const ctx = await launch(input.profile);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await signIn(page);
    await ensureIdentity(page);
    await engineReady(page);
    await phase.check("b1-create-revise-publish", "create, revise and publish through the page's Turnkey session", async () => {
      const created = await must(page, "create", "Acceptance harbor", "Orbits", png(PNG_A));
      // Before anything is published: the account's identity DID must be on
      // this staging domain (hosted-README.md "Account"), or B2 can't bind it.
      const expected = new URL(base).host;
      const didDomain = { expected, actual: didWebvhDomain(created.author), status: didWebvhDomain(created.author) === expected ? "PASS" : "FAIL" };
      phase.facts.didDomain = didDomain;
      assertEqual(didDomain.actual, expected, "the identity DID's domain (use a fresh sub-org minted on this staging build)");
      await must(page, "update", "Acceptance harbor, revised", "Orbits", png(PNG_B));
      const published = await must(page, "publish");
      assertEqual(published.publication, "complete", "publication");
      phase.facts.work1 = facts(published);
      return phase.facts.work1;
    });
    await phase.check("b1-did-domain", "the account's identity DID is on this staging did:webvh domain", async () => {
      const d = phase.facts.didDomain;
      assert(d && d.status === "PASS", "the identity DID is not on this staging domain", d);
      return d;
    });
    await phase.check("b1-key-roles", "the hosted logs show separate identity (alias control) and authorship roles", async () => {
      const s = await must(page, "snapshot");
      const authorLog = jsonl(await text(didWebvhLogUrl(s.author)));
      const aliasLog = jsonl(await text(didWebvhLogUrl(s.webvhDid)));
      const doc = authorLog.at(-1).state;
      const key = (f) => doc.verificationMethod.find((vm) => vm.id.endsWith(f)).publicKeyMultibase;
      const updateKeys = (log) => log.flatMap((e) => e.parameters?.updateKeys ?? []);
      assert(doc.assertionMethod.length === 1 && doc.assertionMethod[0].endsWith("#key-1"), "assertionMethod is not exactly #key-1", doc.assertionMethod);
      assert(s.history.every((h) => h.authorKey === `${s.author}#key-1`), "an entry is not signed by #key-1", s.history);
      assert(updateKeys(authorLog).some((k) => k.includes(key("#key-0"))), "the identity key is not the author DID's update key");
      assert(updateKeys(aliasLog).some((k) => k.includes(key("#key-0"))), "the identity key does not control the alias (P3.7)");
      assert(![...updateKeys(authorLog), ...updateKeys(aliasLog)].some((k) => k.includes(key("#key-1"))), "the authorship key is an update key (P5.11)");
      phase.facts.author = { did: s.author, logUrl: didWebvhLogUrl(s.author), didDomain: phase.facts.didDomain };
      phase.facts.roles = {
        identity: { verificationMethod: "#key-0", turnkeyPath: "m/44'/501'/1'/0'", publicKeyMultibase: key("#key-0"), updateKey: true, controlsAlias: true },
        authorship: { verificationMethod: "#key-1", turnkeyPath: "m/44'/501'/0'/0'", publicKeyMultibase: key("#key-1"), updateKey: false, assertionMethod: true },
      };
      return phase.facts.roles;
    });
    for (const [name, match] of [["work2", () => true], ["work3", (k) => k.includes("/originals/resources/")]]) {
      await phase.check(`b4-interrupt-${name}`, name === "work2" ? "publication interrupted after the publish entry" : "publication interrupted during the resource uploads", async () => {
        const created = await must(page, "create", `Acceptance ${name}`, "Orbits", png(PNG_A));
        await interruptUploads(page, match);
        const r = await call(page, "publish");
        await page.unrouteAll({ behavior: "ignoreErrors" });
        assert(!r.ok, "the interrupted publication reported success", r);
        const s = await must(page, "snapshot");
        assertEqual(s.publication, "incomplete", "publication after the interruption");
        assertEqual(s.history.length, created.history.length + 1, "the publish entry is committed");
        phase.facts[name] = facts(s);
        return phase.facts[name];
      });
    }
    await ctx.close();
  },

  /** B3 same client, and B4 resume: a new browser process on client A's profile. */
  async "client-a-restart"() {
    const ctx = await launch(input.profile);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await signIn(page);
    await engineReady(page);
    const { work1, work2, work3 } = input.prior;
    await phase.check("b3-reopen-continue", "after the restart the work is listed on /me as in this browser, reopens and takes the next revision", async () => {
      const listed = await libraryRows(page);
      // Listed, openable and with no problem: a fork or divergence here is a FAIL, never a pass (#996).
      for (const w of [work1, work2, work3]) assert(listed.some((o) => o.did === w.did && o.openable && !o.problem && /in this browser/i.test(o.labels)), `${w.did} is not listed as in this browser, openable and without a problem`, listed);
      const reopened = await must(page, "open", work1.did);
      assertEqual(reopened.history.at(-1).versionId, work1.checkpoint, "checkpoint");
      const next = await must(page, "update", "Acceptance harbor, after restart", "Orbits", png(PNG_A));
      assertEqual(next.history.length, work1.entries + 1, "entries");
      phase.facts.work1 = facts(next);
      return phase.facts.work1;
    });
    for (const name of ["work2", "work3"]) {
      const w = input.prior[name];
      await phase.check(`b4-resume-${name}`, `${name}: resumes with the same alias and checkpoint and one publish entry`, async () => {
        const reopened = await must(page, "open", w.did);
        assertEqual(reopened.publication, "incomplete", "publication after the restart");
        const early = await call(page, "update", "too early", "Orbits", png(PNG_B));
        assert(!early.ok && /Finish publishing/.test(early.message), "an edit on a half-published snapshot was not refused", early);
        const resumed = await must(page, "publish");
        assertEqual([resumed.publication, resumed.webvhDid, resumed.history.at(-1).versionId, resumed.history.length], ["complete", w.alias, w.checkpoint, w.entries], "publication, alias, checkpoint, entries");
        phase.facts[name] = facts(resumed);
        return phase.facts[name];
      });
    }
    await ctx.close();
  },

  /** B3 another client: an empty profile, signed in to the same account. */
  async "client-b"() {
    const ctx = await launch(input.profile);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await signIn(page);
    await engineReady(page);
    const { work1 } = input.prior;
    await phase.check("b3-other-client-restore", "another client restores the published work from the host and continues it", async () => {
      const listed = await libraryRows(page);
      assert(listed.some((o) => o.did === work1.did && o.openable && !o.problem && /saved to account/i.test(o.labels)), "the published work is not listed on /me as saved to the account, openable and without a problem", listed);
      const restored = await must(page, "restore", work1.did);
      assertEqual([restored.publication, restored.webvhDid, restored.history.at(-1).versionId], ["complete", work1.alias, work1.checkpoint], "publication, alias, head");
      const next = await must(page, "update", "Acceptance harbor, other client", "Orbits", png(PNG_B));
      assertEqual(next.history.length, work1.entries + 1, "entries");
      phase.facts.work1 = facts(next);
      return phase.facts.work1;
    });
    await ctx.close();
  },

  /**
   * B3 on staging, C12-125: back on client A's profile, whose copy is now a
   * revision behind B's. A save on its old parent is refused, never rebased.
   */
  async "client-a-stale"() {
    const ctx = await launch(input.profile);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await signIn(page);
    await engineReady(page);
    const { work1 } = input.prior;
    await phase.check("b3-stale-parent", "client A, a revision behind, can't save on its old parent: refused, not rebased", async () => {
      const opened = await must(page, "open", work1.did);
      const parent = opened.history.at(-1).versionId;
      const stale = await call(page, "update", "Acceptance harbor, stale copy", "Orbits", png(PNG_A));
      assert(!stale.ok && stale.name === "StaleSaveError", "a save on a stale parent was not refused", stale);
      const after = await must(page, "snapshot");
      assertEqual(after.history.at(-1).versionId, parent, "client A's head after the refusal");
      return { parent, refused: stale.name };
    });
    await ctx.close();
  },

  /**
   * B5: a signed-out guest page. Owner decision of 23 October 2026 (#992):
   * the guest key and work are kept in this browser's guest database,
   * unencrypted, with a warning; publishing needs sign-in; nothing goes to
   * an account database or the server.
   */
  async "signed-out"() {
    const ctx = await launch(null);
    const page = await ctx.newPage();
    const writes = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && r.method() !== "HEAD" && new URL(r.url()).pathname.startsWith("/api/")) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await engineReady(page, false);
    await phase.check("b5-guest", "signed out: the guest-key warning shows, publishing is unavailable, guest work survives a reload in the guest database only, and nothing reaches an account database or the server", async () => {
      const body = await page.textContent("body");
      assert(/unencrypted/i.test(body) && /anyone using this browser can sign as this guest/i.test(body), "the page doesn't warn that the guest key is kept in this browser");
      const created = await must(page, "create", "Signed-out sketch", "Orbits", png(PNG_A));
      const zip = Uint8Array.from((await must(page, "evidencePackage")).__bytes);
      const pub = await call(page, "publish");
      assert(!pub.ok, "a signed-out Original was published", pub);
      const latin = Buffer.from(zip).toString("latin1");
      const hits = ["secretKey", "privateKey", "secretKeyMultibase"].filter((n) => latin.includes(n));
      if (/z3u2[1-9A-HJ-NP-Za-km-z]{40,}/.test(latin)) hits.push("multikey-secret");
      assertEqual(hits, [], "private key material in the package");
      await page.reload();
      await engineReady(page, false);
      const reopened = await must(page, "open", created.did);
      assertEqual(reopened.history.map((h) => h.versionId), created.history.map((h) => h.versionId), "the guest work after a reload");
      const stored = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
      assert(stored.includes("originals-library-v1:guest"), "the guest work isn't in the guest database", stored);
      assert(!stored.some((n) => n?.startsWith("originals-library-v1:account:")), "a signed-out page opened an account database", stored);
      assertEqual(writes, [], "writes a signed-out page sent to the server");
      return { packageSha256: sha256Hex(zip), files: Object.keys(readEvidence(zip).bytes).length, stored };
    });
    await ctx.close();
  },

  /** B6: production still has publishing off. */
  async production() {
    const prod = (input.productionUrl ?? "https://originals.build").replace(/\/$/, "");
    const ctx = await launch(null);
    const page = await ctx.newPage();
    await phase.check("b6-production-off", "production serves a build with publishing disabled", async () => {
      const version = await (await fetch(`${prod}/api/version`)).json().catch(() => null);
      await page.goto(prod, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.getElementById("demo")?.scrollIntoView());
      await page.getByText("Publishing to the web is being rebuilt", { exact: false }).first().waitFor({ timeout: 30_000 });
      return { version };
    });
    await ctx.close();
  },
};

if (typeof actions[input.action] !== "function") throw new Error(`unknown action ${input.action}; one of ${Object.keys(actions).join(", ")}`);
await actions[input.action]();
phase.finish();
