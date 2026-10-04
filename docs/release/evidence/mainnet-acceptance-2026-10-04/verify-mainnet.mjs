// Read-only public acceptance probe. Uses the deployed application's own SDK modules.
// Run from repo root: node docs/release/evidence/mainnet-acceptance-2026-10-04/verify-mainnet.mjs
// Artifacts go to MAINNET_PROOF_DIR (default: a new temporary directory).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(resolve('apps/landing/package.json'));
const { chromium } = require('playwright-core');
const origin = 'https://originals.build';
const did = 'did:webvh:QmQx4uVtBmx22aFv3LDH8r79ztaVBatVWihyVbH89ZaEJe:originals.build:published:accounts:00da079c-a004-474a-b09f-0ea12dcbeccb:uEiCt-PPt6WQV7pEvvR-fu2tQszVfbbQy8uIaqcE5aX2TPw';
const assetId = 'did:cel:uEiCt-PPt6WQV7pEvvR-fu2tQszVfbbQy8uIaqcE5aX2TPw';
const sat = '321959825743820';
const expectedDigest = '98bbbe3fed7293f4b2c335f66fe76025ef9da84c18a905d297598aafaa663e33';
const profile = await mkdtemp(join(tmpdir(), 'originals-mainnet-clean-profile-'));
assert.deepEqual(await readdir(profile), []);
const artifacts = process.env.MAINNET_PROOF_DIR ?? await mkdtemp(join(tmpdir(), 'originals-mainnet-proof-'));
await mkdir(artifacts, { recursive: true });
let context;
const requests = [], responses = [], denied = [], errors = [];
const startedAt = new Date().toISOString();
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 1440, height: 1100 },
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    serviceWorkers: 'block',
  });
  assert.deepEqual(await context.cookies(), []);
  await context.route('**/*', async route => {
    const req = route.request();
    if (!['GET', 'HEAD'].includes(req.method()) || new URL(req.url()).origin !== origin) {
      denied.push({ method: req.method(), url: req.url() });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('request', r => requests.push({ method: r.method(), url: r.url() }));
  page.on('response', r => responses.push({ status: r.status(), url: r.url() }));
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/api/health', { waitUntil: 'networkidle' });
  const preconditions = await page.evaluate(async () => ({
    localStorageKeys: Object.keys(localStorage), sessionStorageKeys: Object.keys(sessionStorage),
    indexedDB: await indexedDB.databases(), cacheStorage: await caches.keys(),
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).map(r => r.scope),
    sessionStatus: (await fetch('/api/me', { cache: 'no-store' })).status,
    userAgent: navigator.userAgent,
  }));
  for (const k of ['localStorageKeys','sessionStorageKeys','indexedDB','cacheStorage','serviceWorkers']) assert.deepEqual(preconditions[k], []);
  assert.equal(preconditions.sessionStatus, 401);
  const cookiesBeforeApp = (await context.cookies()).map(c => c.name);
  assert.deepEqual(cookiesBeforeApp, []);
  await page.goto(origin + '/explore/' + encodeURIComponent(did), { waitUntil: 'domcontentloaded' });
  await page.locator('[data-verified="true"]').waitFor({ timeout: 60000 });
  await page.getByText('1 accepted on-chain publication verified (provider-asserted)', { exact: false }).waitFor();
  await page.screenshot({ path: join(artifacts, 'clean-browser.png'), fullPage: true });
  const pageText = await page.locator('main').innerText();
  // These exact module names are from the deployed, byte-compared build. A later
  // deployment changing them should fail this pinned receipt, not silently adapt.
  const proof = await page.evaluate(async ({ did, assetId, sat }) => {
    const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    const { r: SDK } = await import('/assets/dist-DllIi3IQ.js');
    const { PublicSatSnapshotProvider } = await import('/assets/public-sat-provider-B50M_BPl.js');
    const { verifyOriginal, evaluateBtcoCheck } = await import('/assets/verify-original-oHYYbjmL.js');
    const storageReads = [];
    const storageAdapter = {
      put: async () => { throw Error('Read-only acceptance probe'); },
      get: async key => {
        const url = new URL('https://' + key);
        if (url.origin !== location.origin) throw Error('Unexpected storage origin');
        const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
        if (!response.ok) throw Error('Storage HTTP ' + response.status);
        const content = new Uint8Array(await response.arrayBuffer());
        storageReads.push({ url: url.href, status: response.status, bytes: content.length, sha256: await digest(content) });
        return { content, contentType: response.headers.get('content-type') };
      },
    };
    const sdk = SDK.create({ network: 'mainnet', ordinalsProvider: new PublicSatSnapshotProvider(), storageAdapter });
    const accepted = await sdk.lifecycle.resolveAssetFromSat(sat, { expectedAssetId: assetId });
    if (accepted.status !== 'accepted') throw Error('Bitcoin result ' + accepted.status);
    const hosted = await sdk.lifecycle.resolveAssetFromWeb(did);
    const complete = await sdk.lifecycle.loadAsset(JSON.stringify({ ...accepted.asset.serialize(), resources: hosted.asset.serialize().resources }));
    const rowResponse = await fetch('/api/explore/original?' + new URLSearchParams({ did }), { credentials: 'omit', cache: 'no-store' });
    const { original } = await rowResponse.json();
    const logResponse = await fetch(original.logUrl, { credentials: 'omit', cache: 'no-store' });
    const logText = await logResponse.text();
    const resource = hosted.asset.resources.find(r => r.id === 'tla-logo.png');
    const checks = await verifyOriginal({ did, logEntries: logText.trim().split('\n').map(s => JSON.parse(s)), celLog: hosted.asset.celLog,
      resourceBytes: resource.content, declaredHash: await digest(resource.content), sat, btcoResolution: accepted });
    return {
      assetId: accepted.asset.id, state: accepted.resolution.state, tip: accepted.resolution.tip,
      publications: accepted.resolution.publications, ownership: accepted.resolution.ownership,
      assurance: { chain: accepted.resolution.chainEvidence.assurance, enumeration: accepted.resolution.enumerationAssurance,
        content: accepted.resolution.contentAssurance, ownership: accepted.resolution.ownershipAssurance, trajectory: accepted.resolution.trajectoryAssurance },
      satOnly: { verified: accepted.verification.verified, missingResources: accepted.verification.missingResources, resourceAvailability: accepted.resourceAvailability },
      hosted: { verified: hosted.verification.verified, head: hosted.asset.state.head, webvhStatus: logResponse.status, webvhLogSha256: await digest(new TextEncoder().encode(logText)) },
      full: { verified: complete.verification.verified, head: complete.asset.state.head,
        resources: await Promise.all(complete.asset.resources.map(async r => ({ id: r.id, bytes: r.content?.byteLength, sha256: r.content ? await digest(r.content) : null }))) },
      checks, bitcoinCheck: evaluateBtcoCheck({ sat, celVerified: checks.find(c => c.id === 'cel')?.ok, assetId, resolution: accepted }),
      storageReads,
    };
  }, { did, assetId, sat });
  assert.equal(proof.assetId, assetId);
  assert.equal(proof.hosted.verified, true);
  assert.equal(proof.full.verified, true);
  assert.equal(proof.full.head, proof.state.head);
  assert.equal(proof.state.entryCount, 3);
  assert.equal(proof.full.resources.find(r => r.id === 'tla-logo.png')?.sha256, expectedDigest);
  assert.equal(proof.full.resources.find(r => r.id === 'tla-logo.png')?.bytes, 3857);
  assert.equal(proof.publications[0].inscriptionId, 'cdb2eccae0a929f7e5c7459893eb34e24d8099850e04d323963d19d5f4a344d9i0');
  assert.ok(proof.checks.every(c => c.ok));
  assert.equal(proof.bitcoinCheck.ok, true);
  assert.deepEqual(denied, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await context.cookies(), []);
  const postconditions = await page.evaluate(() => ({ localStorageKeys: Object.keys(localStorage), sessionStorageKeys: Object.keys(sessionStorage) }));
  assert.deepEqual(postconditions, { localStorageKeys: [], sessionStorageKeys: [] });
  const receipt = { status: 'PASS', startedAt, completedAt: new Date().toISOString(),
    browser: context.browser()?.version(), profile: { newlyCreatedEmptyDirectory: true, isolatedProcess: true, reused: false, deletedAfterRun: true },
    appUrl: page.url(), preconditions, cookiesBeforeApp, postconditions, pageText, proof, requests, responses, denied, errors,
    limits: ['Existing owner asset only; no creation, signing, funding or broadcast.', 'Chain/index/content/ownership evidence is provider-asserted; no independently derived sat trajectory.', 'PNG is Bitcoin-inline; metadata.json remains hosted.', 'Full-resource SDK verification is a supplemental browser-side read using shipped modules; the normal Explore UI verifies the primary file and accepted publication.'] };
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', artifacts, browser: receipt.browser, checks: proof.checks }));
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ startedAt, error: String(error.stack ?? error), requests, responses, denied, errors }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
