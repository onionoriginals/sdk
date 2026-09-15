import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const chrome =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTest = existsSync(chrome) ? test : test.skip;
// Isolate Bun.build's fixture bundle and cache from the rest of the test suite.
const isolated = process.env.EXPLORE_BROWSER_CHILD === "1";
if (!isolated) {
  browserTest(
    "public Bitcoin verification browser scenarios",
    async () => {
      const child = Bun.spawn(
        [process.execPath, "test", fileURLToPath(import.meta.url)],
        {
          env: { ...process.env, EXPLORE_BROWSER_CHILD: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stdout + stderr).toBe(0);
    },
    30_000,
  );
}
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

// The hosted checks and provider result are fixtures; the component, React
// lifecycle and evaluateBtcoCheck binding decision are real.
beforeAll(async () => {
  if (!isolated || !existsSync(chrome)) return;
  const pagePath = root + "/pages/ExploreOriginal.tsx";
  const mocks: Record<string, string> = {
    "./Explore":
      'export const OriginalArtwork=()=>null; export const publicationDate=()=>"today";',
    "./original-detail-data":
      'export const parseDidLog=()=>[]; export const digestMultibaseSha256Hex=()=>"hash";',
    "../sdk/verify-original": `export { evaluateBtcoCheck } from ${JSON.stringify(root + "/sdk/verify-original.ts")}; export const verifyOriginal=async()=>['hash','log','cel'].map(id=>({id,ok:true,detail:'fixture hosted verification'}));`,
    "@originals/sdk/cel": `export const validateDocument=x=>x; export const verifyHistory=()=>({state:{active:true,assetId:'ni:///sha-256;'+ 'A'.repeat(43),controller:'controller',resources:[]}});`,
    "../sdk/public-sat-provider": `export class PublicSatSnapshotProvider { async getSatSnapshot(){if(window.qa.mode==='unavailable')throw Error('fixture unavailable');return {network:'regtest'};} }`,
    "@originals/sdk": `export const OriginalsSDK={create:()=>({lifecycle:{resolveAssetFromSat:async()=>({status:'accepted',asset:{id:window.qa.mode==='accepted'?'ni:///sha-256;'+'A'.repeat(43):'ni:///sha-256;'+'B'.repeat(42)+'A'},resolution:{state:{controller:'controller',active:true},publications:[{}],chainEvidence:{assurance:'node-validated'}}})}})};`,
  };
  const build = await Bun.build({
    entrypoints: [pagePath],
    target: "browser",
    plugins: [
      {
        name: "explore-hint-fixtures",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            args.importer === pagePath && mocks[args.path]
              ? { path: args.path, namespace: "hint-fixture" }
              : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "hint-fixture" }, (args) => ({
            contents: mocks[args.path],
            loader: "js",
            resolveDir: root + "/pages",
          }));
          b.onLoad({ filter: /\.css$/ }, () => ({
            contents: "",
            loader: "js",
          }));
          b.onLoad({ filter: /ExploreOriginal\.tsx$/ }, () => ({
            loader: "tsx",
            contents:
              readFileSync(pagePath, "utf8") +
              `
 import { createRoot } from 'react-dom/client';
 window.qa={mode:new URLSearchParams(location.search).get('mode')};
 const row={did:'did:webvh:fixture',title:'Fixture Original',createdAt:'2026-09-15',controller:'controller',assetId:'ni:///sha-256;'+'A'.repeat(43),resourceCount:1,resourceContentType:'text/plain',sat:'42',logUrl:'/did.jsonl',celUrl:'/cel.json',resourceUrl:'/resource'};
 window.fetch=async(input)=>String(input).startsWith('/api/explore/original?')?Response.json({original:row}):String(input)==='/cel.json'?Response.json({}):new Response('[]');
 createRoot(document.getElementById('root')).render(<ExploreOriginal did={row.did}/>);
 `,
          }));
        },
      },
    ],
  });
  if (!build.success) throw Error(build.logs.join("\n"));
  const js = await build.outputs[0].text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      return new URL(req.url).pathname === "/component.js"
        ? new Response(js, { headers: { "Content-Type": "text/javascript" } })
        : new Response(
            '<div id="root"></div><script type="module" src="/component.js"></script>',
            { headers: { "Content-Type": "text/html" } },
          );
    },
  });
  browser = await chromium.launch({ executablePath: chrome, headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
for (const mode of isolated ? ["unrelated", "unavailable", "accepted"] : []) {
  browserTest(
    `Bitcoin ${mode} outcome controls the public inscription claim`,
    async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      try {
        await page.goto(server.url + "?mode=" + mode);
        await page
          .getByRole("heading", { name: "Fixture Original", exact: true })
          .waitFor();
        const expected =
          mode === "accepted"
            ? "1 accepted on-chain publication verified (node-validated) → sat 42"
            : mode === "unrelated"
              ? "Accepted Bitcoin history does not bind to this Original"
              : "Bitcoin publication could not be verified";
        await page
          .getByText(
            mode === "accepted" ? "Bitcoin inscription" : "Satoshi to verify",
            { exact: true },
          )
          .waitFor();
        await page.getByText(expected, { exact: true }).waitFor();
        const verified = await page
          .locator(".explore-verification")
          .getAttribute("data-verified");
        expect(verified).toBe(String(mode === "accepted"));
        expect(
          await page
            .getByText(
              mode === "accepted" ? "Satoshi to verify" : "Bitcoin inscription",
              { exact: true },
            )
            .count(),
        ).toBe(0);
      } finally {
        await page.close();
      }
    },
  );
}
