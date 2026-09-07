/** Real SDK publications → HTTP → Chromium. Run after landing:check.
 * Optional EXPLORE_SCREENSHOTS directory receives desktop/mobile evidence.
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { chromiumExecutablePath } from './browser.mjs';
import {
  OriginalsSDK,
  createLocalSigner,
  type StorageAdapter,
} from '@originals/sdk';
import { createOriginalsStore } from '../server/originals-store';
import { createOriginalsRoutes } from '../server/originals-routes';
import { createExploreRoutes } from '../server/explore';
import { createWebvhHostStore } from '../server/webvh-host';
import { buildFetch } from '../server/app';

const dataDir = mkdtempSync(join(tmpdir(), 'explore-browser-'));
const store = createOriginalsStore({ dataDir });
const originals = createOriginalsRoutes({
  store,
  jwtSecret: 'disposable-browser-test-secret-32-characters',
});
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: buildFetch({
    apiRoutes: { 'GET /api/originals': originals.list },
    originals,
    hostStore: createWebvhHostStore(),
    distDir: new URL('../dist/', import.meta.url).pathname,
    explore: createExploreRoutes({ store, dataDir }),
    trustedProxyHops: 0,
    log: () => {},
  }),
});
const origin = `http://explore.localhost:${server.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: chromiumExecutablePath() });
  for (let i = 0; i < 26; i++) {
    const sub = `creator-${i % 3}`;
    const storageAdapter: StorageAdapter = {
      async putObject(host, path, bytes, options) {
        store.saveBytes(
          sub,
          `${host}/${path}`,
          typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
          options?.contentType ?? 'application/octet-stream',
        );
        return `https://${host}/${path}`;
      },
      async getObject(host, path) {
        const r = store.read(sub, `${host}/${path}`);
        return r.ok
          ? {
              content: new Uint8Array(await r.arrayBuffer()),
              contentType: r.headers.get('content-type') ?? undefined,
            }
          : null;
      },
      async exists(host, path) {
        return store.read(sub, `${host}/${path}`).ok;
      },
    };
    const title = i === 1 ? 'Tidal study' : `Field notes ${i + 1}`;
    const colors = [
      '#afccbc',
      '#c8b497',
      '#a9b7cd',
      '#d2ab8f',
      '#babc9c',
      '#c6a9a2',
    ];
    const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="${colors[i % 6]}"/><circle cx="${220 + i * 8}" cy="310" r="185" fill="#ece7da"/><path d="M0 560 Q220 ${280 + i * 10} 800 450V800H0Z" fill="#273f3b"/><path d="M0 710 Q400 400 800 660V800H0Z" fill="#687769"/></svg>`;
    const sdk = OriginalsSDK.create({
      signer: createLocalSigner(
        'Ed25519',
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      storageAdapter,
    });
    const textFile = i === 24;
    const asset = await sdk.lifecycle.createAsset(
      [
        {
          id: textFile ? 'notes.txt' : 'art.svg',
          mediaType: textFile ? 'text/plain' : 'image/svg+xml',
          content: textFile ? 'A small observation, kept.' : artwork,
        },
      ],
      { name: title },
    );
    const publication = await sdk.lifecycle.publishToWeb(asset, {
      domain: `explore.localhost:${server.port}`,
    });
    store.recordOriginal(sub, {
      did: publication.did,
      title,
      createdAt: new Date().toISOString(),
      resourceHash: '',
    });
  }
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ready = (count = 24) =>
    page.waitForFunction(
      (count) =>
        document.querySelectorAll('.explore-grid > li').length === count,
      count,
    );
  const shots = process.env.EXPLORE_SCREENSHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  await page.goto(origin + '/explore');
  await ready();
  assert.equal(
    await page.locator('.explore-count').textContent(),
    '26 Originals',
  );
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          '.explore-grid > li:first-child img',
        ) as HTMLImageElement
      )?.naturalWidth > 0,
  );
  assert.equal(
    await page
      .locator('.explore-file')
      .filter({ hasText: 'text/plain' })
      .count(),
    1,
  );
  if (shots)
    await page.screenshot({ path: join(shots, 'explore-desktop.png') });
  await page
    .getByRole('button', { name: 'Load more Originals', exact: true })
    .click();
  await ready(26);
  assert.equal(
    await page
      .getByRole('button', { name: 'Load more Originals', exact: true })
      .count(),
    0,
  );
  await page.getByRole('searchbox').fill('tidal');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.explore-count')?.textContent ===
      '1 Original · “tidal”',
  );
  await page
    .getByRole('link', { name: 'Explore Original: Tidal study' })
    .click();
  await page
    .locator('.explore-verification[data-verified="true"]')
    .waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('h1').textContent(), 'Tidal study');
  if (shots)
    await page.screenshot({
      path: join(shots, 'explore-detail.png'),
      fullPage: true,
    });
  await page.route('**/resources/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: 'tampered resource',
    }),
  );
  await page.reload();
  await page.locator('.explore-verification').filter({ hasText: 'Verification incomplete' }).waitFor();
  assert.equal(
    await page.locator('.explore-detail-art img').count(),
    0,
    'tampered bytes never become a preview',
  );
  await page.unroute('**/resources/*');
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `detail fits ${width}px`,
    );
  }
  await page.locator('.explore-back').click();
  await ready();
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `gallery fits ${width}px`,
    );
  }
  await page.setViewportSize({ width: 375, height: 900 });
  if (shots) await page.screenshot({ path: join(shots, 'explore-mobile.png') });
  await page.getByRole('searchbox').fill('no matching publication');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('heading', { name: 'No Originals match your search.' })
    .waitFor();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await ready();
  // Only the failure case is injected; all earlier reads use real artifacts.
  await page.route('**/api/explore?*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
  await page.reload();
  await page
    .getByRole('alert')
    .filter({ hasText: 'collection could not' })
    .waitFor();
  await page.unroute('**/api/explore?*');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await ready();
  await page.goto(
    origin + '/explore/' + encodeURIComponent('did:webvh:missing'),
  );
  await page
    .getByRole('heading', {
      name: 'This Original is not available in the public collection.',
    })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Explore browser PASS: signed publications, pagination, search, file fallback, public verification, responsive layouts, empty search, retry and missing detail.',
  );
} finally {
  await browser?.close();
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
}
