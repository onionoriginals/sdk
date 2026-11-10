#!/usr/bin/env node
/**
 * Prove that a web app built on the browser entries needs no bundler shims.
 *
 * Builds a small app with Vite and **no** aliases, polyfills, `define`s or
 * manual chunks: it imports only `@originals/sdk/did`, `@originals/sdk/originals`
 * and `@originals/vh/*`, as Easel, Commission Desk and the landing do once they
 * stop importing the root `@originals/sdk`. The build fails on any warning
 * that a module was externalized for browser compatibility (a Node built-in
 * reached from the graph). The app then runs in headless Chromium: it mints a
 * did:webvh identity (#key-0 identity, #key-1 authorship), creates and edits
 * an Original, publishes it at a did:webvh alias, packages it and loads the
 * package back, and must report it valid with no page error.
 *
 *   node scripts/check-browser-bundle.mjs   (after `bun run build`)
 *
 * Needs a Chromium for playwright-core (CHROMIUM_PATH, or `playwright-core install chromium`).
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Inside the repo, so the workspace's node_modules resolve the packages as an app's would.
const APP = join(ROOT, 'node_modules', '.cache', 'originals-browser-check');
rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

writeFileSync(join(APP, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="./main.js"></script>');
writeFileSync(join(APP, 'main.js'), `
import { createWebvhAlias, createWebvhIdentity, localWebvhSigner, userPathSegment, aliasPathSegment } from '@originals/sdk/did';
import { MemoryStore, OriginalsSDK, keySigner } from '@originals/sdk/originals';
import { localSigner } from '@originals/vh/crypto';

async function run() {
  const secret = (n) => crypto.getRandomValues(new Uint8Array(32)).fill(n, 0, 1);
  const identityKey = secret(1), authorshipKey = secret(2);
  const identitySigner = localWebvhSigner(identityKey);
  const identity = await createWebvhIdentity({
    domain: 'example.com', paths: [userPathSegment('0123456789abcdef-sub')],
    identitySigner, authorshipKey: localSigner('Ed25519', authorshipKey).publicKeyMultibase,
  });
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [identity.evidence] });
  const signer = keySigner({ keyType: 'Ed25519', secretKey: authorshipKey, verificationMethod: identity.ref.verificationMethod });
  const created = await sdk.create({ name: 'Sketch', resource: { mediaType: 'image/png', bytes: new Uint8Array(70000).fill(7) }, author: identity.ref, signer });
  const edited = await sdk.edit(created.original.did, { parent: created.original.checkpoint, resource: { bytes: new Uint8Array(70000).fill(8) }, author: identity.ref, signer });
  const alias = await createWebvhAlias({ domain: 'example.com', paths: [userPathSegment('0123456789abcdef-sub'), aliasPathSegment(edited.original.did)], signer: identitySigner, original: edited.original.did });
  const published = await sdk.publish(edited.original.did, { parent: edited.original.checkpoint, author: identity.ref, signer, alias });
  const pkg = await sdk.package(published.original.did);
  const loaded = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).load(pkg.bytes);
  return {
    identity: identity.did, original: published.original.did, aliases: published.original.state.aliases,
    versions: loaded.report.resources.versions.map((v) => v.bytes), blocking: loaded.reasons.filter((r) => r !== 'not-anchored'),
    valid: loaded.report.validAsOf !== null, history: loaded.report.history.status,
  };
}
window.__result = run().catch((e) => ({ error: String(e && e.stack || e) }));
`);

const externalized = [];
await build({
  root: APP,
  logLevel: 'warn',
  configFile: false,
  build: { outDir: join(APP, 'dist'), emptyOutDir: true, target: 'es2022', minify: false },
  customLogger: {
    info() {}, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false,
    warnOnce(msg) { this.warn(msg); },
    warn(msg) {
      if (/externalized for browser compatibility|has been externalized/.test(msg)) externalized.push(msg.split('\n')[0]);
      else console.warn(msg);
    },
    error(msg) { console.error(msg); },
  },
});
if (externalized.length > 0) {
  console.error(`Browser bundle check FAILED: Node built-ins reached from the browser entries:\n  ${externalized.join('\n  ')}`);
  process.exit(1);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const path = join(APP, 'dist', req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(path)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
});
await new Promise((r) => server.listen(0, 'localhost', r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForFunction(() => window.__result !== undefined, undefined, { timeout: 60_000 });
  const result = await page.evaluate(() => window.__result);
  const ok = !result.error && errors.length === 0 && result.valid && result.history === 'valid' && result.blocking.length === 0 &&
    result.identity.startsWith('did:webvh:') && result.aliases.length === 1 && result.versions.join() === 'verified,verified';
  if (!ok) {
    console.error('Browser bundle check FAILED in Chromium:', JSON.stringify({ result, errors }, null, 2));
    process.exit(1);
  }
  console.log(`Browser bundle check passed: built with no shims and ran in Chromium ${browser.version()} (identity, create, edit, publish, package, load).`);
} finally {
  await browser.close();
  server.close();
}
