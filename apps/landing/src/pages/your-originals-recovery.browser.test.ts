import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

// Exercise the real component and React lifecycle. Only custody/network adapters
// are deferred fixtures; account changes and unmounts use actual React commits.
const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browserTest = existsSync(chrome) ? test : test.skip;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!existsSync(chrome)) return;
  const pagePath = fileURLToPath(new URL('./YourOriginals.tsx', import.meta.url));
  const mocks: Record<string, string> = {
    '../auth/useAuth': `import { useSyncExternalStore } from ${JSON.stringify(fileURLToPath(import.meta.resolve('react')))};
      export function useAuth() {
        const account = useSyncExternalStore((notify) => { window.addEventListener('account', notify); return () => window.removeEventListener('account', notify); }, () => window.qa.account);
        return { isAuthenticated: !!account, isLoading: false, bitcoin: null, user: account ? { subOrgId: account } : null };
      }`,
    '../sdk/local-publication-recovery': `
      export const localPublicationRecoveries = (account) => [{ key: account, kind: 'web', title: 'Retained ' + account, assetDid: 'did:cel:' + account }];
      export const recoverLocalPublication = (account, key, storage, isCurrent) => new Promise((resolve, reject) => window.qa.pending.push({ account, isCurrent, resolve, reject }));`,
    '../router': `export const navigate = () => {}; export const originalPath = () => '/';`,
    './original-detail-data': `export const sameOriginUrl = (url) => url;`,
    './inscribe-availability': `export const inscribeAvailability = () => ({ allowed: false }); export const rowAfterInscribe = (row) => row; export const unclaimedInscriptions = () => [];`,
    './resume-inscribe': `export const fetchHostedCel = async () => null; export const resolveAuthorshipDid = async () => null; export const resumeInscribe = async () => ({});`,
    '@originals/sdk': `export const OriginalsSDK = { create: () => ({ lifecycle: { resolveAssetFromWeb: async () => ({ verification: { verified: false } }) } }) };`,
    '../sdk/durable-hosting-adapter': `export class DurableHostingStorageAdapter {}`,
  };
  const build = await Bun.build({
    entrypoints: [pagePath],
    target: 'browser',
    plugins: [{ name: 'deferred-recovery-fixtures', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.importer === pagePath && mocks[args.path]) return { path: args.path, namespace: 'recovery-fixture' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'recovery-fixture' }, (args) => ({ contents: mocks[args.path], loader: 'js', resolveDir: fileURLToPath(new URL('.', import.meta.url)) }));
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
      builder.onLoad({ filter: /YourOriginals\.tsx$/ }, () => ({ loader: 'tsx', contents: readFileSync(pagePath, 'utf8') + `
        import { createRoot } from 'react-dom/client';
        window.qa = { account: 'account-a', pending: [], gets: 0, pauseList: false, lists: [] };
        window.fetch = async (input) => {
          window.qa.gets++;
          if (String(input) === '/api/originals' && window.qa.pauseList) {
            window.qa.pauseList = false;
            return new Promise((resolve) => window.qa.lists.push(resolve));
          }
          return Response.json(String(input) === '/api/originals' ? { originals: [] } : { records: [] });
        };
        const root = createRoot(document.getElementById('root'));
        window.qa.switchAccount = (account) => { window.qa.account = account; window.dispatchEvent(new Event('account')); };
        window.qa.unmount = () => root.unmount();
        root.render(<YourOriginals />);
      ` }));
    } }],
  });
  if (!build.success) throw new Error(build.logs.join('\n'));
  const javascript = await build.outputs[0].text();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    return new URL(request.url).pathname === '/component.js'
      ? new Response(javascript, { headers: { 'content-type': 'text/javascript' } })
      : new Response('<div id="root"></div><script type="module" src="/component.js"></script>', { headers: { 'content-type': 'text/html' } });
  } });
  browser = await chromium.launch({ executablePath: chrome, headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

for (const outcome of ['resolve', 'reject', 'list-response'] as const) {
  browserTest(`pending recovery ${outcome} cannot update another account or survive unmount`, async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(3_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(server.url.toString());
      await page.getByText('Retained account-a', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Finish publishing', exact: true }).click();
      await page.waitForFunction(() => (window as any).qa.pending.length === 1);
      if (outcome === 'list-response') {
        await page.evaluate(() => { const qa = (window as any).qa; qa.pauseList = true; qa.pending[0].resolve('Account A recovered'); });
        await page.waitForFunction(() => (window as any).qa.lists.length === 1);
      }
      await page.evaluate(() => (window as any).qa.switchAccount('account-b'));
      await page.getByText('Retained account-b', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Finish publishing', exact: true }).click();
      await page.waitForFunction(() => (window as any).qa.pending.length === 2);
      const gets = await page.evaluate(() => (window as any).qa.gets);
      await page.evaluate((result) => {
        const qa = (window as any).qa;
        if (result === 'resolve') qa.pending[0].resolve('STALE ACCOUNT A RESULT');
        else if (result === 'reject') qa.pending[0].reject(new Error('STALE ACCOUNT A ERROR'));
        else qa.lists[0](Response.json({ originals: [{ did: 'did:webvh:S:example.com:a', title: 'STALE ACCOUNT A ROW', resourceHash: 'aa', createdAt: '2026-09-06T00:00:00Z' }] }));
      }, outcome);
      // The two animation frames also drain the deferred Promise continuations.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.locator('body').innerText()).not.toContain('STALE ACCOUNT A');
      expect(await page.locator('body').innerText()).not.toContain('Account A recovered');
      expect(await page.getByRole('button', { name: 'Retrying…', exact: true }).isDisabled()).toBe(true);
      expect(await page.evaluate(() => (window as any).qa.gets)).toBe(gets);
      expect(await page.evaluate(() => (window as any).qa.pending[0].isCurrent())).toBe(false);
      await page.evaluate(() => (window as any).qa.unmount());
      expect(await page.evaluate(() => (window as any).qa.pending[1].isCurrent())).toBe(false);
      await page.evaluate(() => (window as any).qa.pending[1].resolve('UNMOUNTED RESULT'));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => (window as any).qa.gets)).toBe(gets);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
}
