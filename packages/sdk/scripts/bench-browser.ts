/**
 * `bench-originals.ts` in headless Chromium: the SDK bundled for the browser
 * (MemoryStore, a did:vh author), timed in the page.
 *
 *   bun scripts/bench-browser.ts [--versions 1,25,100] [--size 680000]
 *
 * Needs a Chromium for playwright-core (`bunx playwright-core install
 * chromium`, or CHROMIUM_PATH). Served from localhost, a secure context, so
 * WebCrypto is available as it is on an https page.
 */
import { chromium } from "playwright-core";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const versions = arg("versions", "1,25,100");
const size = arg("size", "680000");

const built = await Bun.build({ entrypoints: [new URL("./bench/browser-entry.ts", import.meta.url).pathname], target: "browser", format: "esm", minify: true });
if (!built.success) throw new AggregateError(built.logs, "bundle failed");
const bundle = await built.outputs[0].text();
const server = Bun.serve({
  port: 0,
  hostname: "localhost",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/bench.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
    return new Response(`<!doctype html><script type="module" src="/bench.js"></script>`, { headers: { "content-type": "text/html" } });
  },
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage();
  // The page is busy for minutes on a slow build: never time out waiting for it.
  page.setDefaultTimeout(0);
  await page.goto(`http://localhost:${server.port}/?versions=${versions}&size=${size}`, { waitUntil: "commit" });
  await page.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench !== undefined, undefined, { timeout: 0 });
  const result = (await page.evaluate(() => (window as unknown as { __bench: Promise<unknown> }).__bench)) as Array<Record<string, number>> | { error: string };
  if (!Array.isArray(result)) throw new Error(result.error);
  console.log(`headless Chromium ${browser.version()}; resource ${size} bytes; ms (median of 3; edit is one run)`);
  console.log(["versions", "edit", "get", "package", "load", "import(new)"].join("\t"));
  const f = (n: number) => (Number.isNaN(n) ? "-" : n < 10 ? n.toFixed(1) : Math.round(n).toString());
  for (const r of result) console.log([r.versions, f(r.edit), f(r.get), f(r.package), f(r.load), f(r.importNew)].join("\t"));
} finally {
  await browser.close();
  server.stop(true);
}
