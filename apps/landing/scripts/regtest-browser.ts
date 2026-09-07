/** Real creator UI → HTTPS routes → disposable Core/ord, including cold recovery.
 * Run explicitly after workspace install/build; this never silently skips Chromium.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { build } from 'vite';
import * as btc from '@scure/btc-signer';
import { base58 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { OriginalsSDK, RegtestProvider, type PreparedBitcoinPublication } from '@originals/sdk';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { createInscriptionsStore } from '../server/inscriptions-store';
import { startRegtest, until } from '../../../scripts/regtest/environment';
import type { FixtureConfig } from './regtest-browser/server';

const landing = fileURLToPath(new URL('../', import.meta.url));
const chrome = process.env.CHROMIUM_PATH ?? process.env.CHROME_BIN ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' :
    existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath());
assert.ok(existsSync(chrome), `Chromium is required; set CHROMIUM_PATH (tried ${chrome})`);
const requested = process.env.REGTEST_BROWSER_FAULT;
assert.ok(!requested || ['commit-response-lost', 'reveal-rejected'].includes(requested), 'Unknown REGTEST_BROWSER_FAULT');
const faults: FixtureConfig['fault'][] = requested ? [requested as FixtureConfig['fault']] : ['commit-response-lost', 'reveal-rejected'];
const artifactRoot = resolve(process.env.REGTEST_BROWSER_ARTIFACTS_DIR ?? process.env.REGTEST_LOGS_DIR ?? join(tmpdir(), `originals-regtest-browser-${Date.now()}`));
await mkdir(artifactRoot, { recursive: true });
const childScenario = process.env.REGTEST_BROWSER_CHILD === '1';
if (!childScenario) await rm(join(artifactRoot, 'receipt.json'), { force: true });
// Vite and Bun's explicit-CA TLS state are process-global. Each independently
// certified scenario gets its own process; only completed receipts aggregate.
if (!requested) {
  const scenarios: unknown[] = [];
  for (const fault of faults) {
    const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url)], {
      cwd: landing, env: { ...process.env, REGTEST_BROWSER_FAULT: fault, REGTEST_BROWSER_CHILD: '1', REGTEST_BROWSER_ARTIFACTS_DIR: artifactRoot },
      stdout: 'inherit', stderr: 'inherit',
    });
    const forwardSignal = () => child.kill('SIGTERM');
    process.once('SIGINT', forwardSignal); process.once('SIGTERM', forwardSignal);
    const code = await child.exited;
    process.removeListener('SIGINT', forwardSignal); process.removeListener('SIGTERM', forwardSignal);
    assert.equal(code, 0, `Browser scenario ${fault} failed; artifacts: ${join(artifactRoot, fault)}`);
    scenarios.push(JSON.parse(await readFile(join(artifactRoot, fault, 'receipt.json'), 'utf8')));
  }
  await writeFile(join(artifactRoot, 'receipt.json'), JSON.stringify({ status: 'passed', scenarios }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', receipt: join(artifactRoot, 'receipt.json') }));
  process.exit(0);
}
const png = process.env.REGTEST_PNG ? new Uint8Array(await readFile(process.env.REGTEST_PNG)) :
  new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const failureDetail = (error: unknown): string => error instanceof Error
  ? `${error.stack ?? error.message}${error.cause ? `\nCaused by: ${failureDetail(error.cause)}` : ''}`
  : String(error);
assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
const receipts: Record<string, unknown>[] = [];

for (const fault of faults) {
  const artifacts = join(artifactRoot, fault);
  await mkdir(artifacts, { recursive: true });
  for (const name of ['receipt.json', 'failure.json', 'failure.png', 'failure.html', '01-interrupted.png', '02-recovered.png']) {
    await rm(join(artifacts, name), { force: true });
  }
  const events: Record<string, unknown>[] = [];
  const checkpoint = (stage: string, details: Record<string, unknown> = {}) => {
    const event = { stage, fault, at: new Date().toISOString(), ...details };
    events.push(event); console.log(JSON.stringify(event));
  };
  checkpoint('start');
  const env = await startRegtest().catch(async error => {
    await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ status: 'failed', fault, stage: 'start', error: failureDetail(error) }, null, 2) + '\n');
    await writeFile(join(artifacts, 'events.json'), JSON.stringify(events, null, 2) + '\n');
    throw error;
  });
  const nativeFetch = globalThis.fetch;
  let app: ReturnType<typeof Bun.spawn> | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const externalRequests: string[] = [];
  const browserErrors: string[] = [];
  const browserConsole: string[] = [];
  let serverGeneration = 0;
  const stopApp = async () => {
    if (!app || app.exitCode !== null) return;
    app.kill('SIGTERM');
    await Promise.race([app.exited, Bun.sleep(5_000)]);
    if (app.exitCode === null) { app.kill('SIGKILL'); await app.exited; }
  };
  const onInterrupt = () => { void (async () => {
    await context?.close(); await stopApp(); await env.stop(); process.exit(130);
  })(); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  try {
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    // A unique hostname also isolates TLS session/trust caches between the
    // separately certified scenarios in this runner process.
    const hostname = `regtest-${reservation.port}.localhost`;
    const origin = `https://${hostname}:${reservation.port}`;
    reservation.stop(true);
    const certPath = join(env.dataDir, 'browser-localhost.crt');
    const keyPath = join(env.dataDir, 'browser-localhost.key');
    const certConfig = join(env.dataDir, 'browser-localhost.cnf');
    await writeFile(certConfig, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${hostname}\n[ext]\nsubjectAltName=DNS:${hostname},IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n`);
    const cert = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', certConfig, '-keyout', keyPath, '-out', certPath], { stdout: 'ignore', stderr: 'pipe' });
    if (await cert.exited) throw new Error(await new Response(cert.stderr).text());
    const ca = await readFile(certPath, 'utf8');
    // Trust only this ephemeral key in this disposable Chromium profile. No
    // global ignoreHTTPSErrors, system trust mutation or public TLS bypass.
    const spki = new X509Certificate(ca).publicKey.export({ type: 'spki', format: 'der' });
    const spkiHash = createHash('sha256').update(spki).digest('base64');
    const allowed = new Set([origin, env.rpcUrl, env.ordUrl]);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (!allowed.has(url.origin)) { externalRequests.push(url.origin); throw new Error(`Regtest runner refused external origin ${url.origin}`); }
      return nativeFetch(input, { ...init, redirect: 'error', ...(url.origin === origin ? { tls: { ca } } : {}) });
    }) as typeof fetch;
    const fundingKey = secp256k1.utils.randomSecretKey();
    const authorshipKey = randomBytes(32);
    const config: FixtureConfig = {
      dataDir: env.dataDir, distDir: join(env.dataDir, 'browser-dist/'), rpcUrl: env.rpcUrl, ordUrl: env.ordUrl, rpcAuth: env.rpcAuth,
      origin, certPath, keyPath, jwtSecret: randomBytes(32).toString('hex'),
      subOrgId: 'disposable-regtest-creator', email: 'regtest@localhost',
      fundingAddress: btc.p2wpkh(secp256k1.getPublicKey(fundingKey, true), { ...btc.TEST_NETWORK, bech32: 'bcrt' }).address!,
      authorshipAddress: base58.encode(ed25519.getPublicKey(authorshipKey)),
      fundingKey: Buffer.from(fundingKey).toString('hex'), authorshipKey: authorshipKey.toString('hex'), fault,
    };
    const configPath = join(env.dataDir, 'browser-fixture.json');
    const writeConfig = () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeConfig();
    checkpoint('build-real-landing');
    await build({ root: landing, configFile: join(landing, 'vite.config.ts'),
      plugins: [{ name: 'disposable-regtest-custody', enforce: 'pre', resolveId(source) {
        if (/(?:^|\/)auth\/(useAuth|turnkey-browser-client)(?:\.tsx?)?$/.test(source)) {
          return join(landing, 'scripts/regtest-browser/session.tsx');
        }
      } }],
      define: { 'import.meta.env.VITE_BTC_NETWORK': JSON.stringify('regtest'), 'import.meta.env.VITE_WEBVH_HOST': JSON.stringify(new URL(origin).host) },
      build: { outDir: config.distDir, emptyOutDir: true },
    });
    const auth = getAuthCookieConfig(signToken(config.subOrgId, config.email, undefined, { secret: config.jwtSecret }), { secure: true });
    const startApp = async () => {
      serverGeneration++;
      app = Bun.spawn([process.execPath, join(landing, 'scripts/regtest-browser/server.ts'), configPath], {
        cwd: landing, stdout: Bun.file(join(artifacts, `server-${serverGeneration}.log`)),
        stderr: Bun.file(join(artifacts, `server-${serverGeneration}.error.log`)),
      });
      await until('real HTTPS landing server', async () => {
        if (app!.exitCode !== null) throw new Error(`Landing server exited ${app!.exitCode}`);
        return (await fetch(`${origin}/api/btc/network`)).ok;
      });
      return app.pid;
    };
    const firstPid = await startApp();
    const profile = join(env.dataDir, 'chromium-profile');
    const openBrowser = async () => {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: chrome, headless: true, viewport: { width: 1440, height: 1100 },
        args: [`--ignore-certificate-errors-spki-list=${spkiHash}`, `--host-resolver-rules=MAP ${hostname} 127.0.0.1`],
        serviceWorkers: 'block',
      });
      await context.addCookies([{ name: auth.name, value: auth.value, url: origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin && !['data:', 'blob:'].includes(url.protocol)) {
          externalRequests.push(url.href); await route.abort('blockedbyclient');
        } else await route.continue();
      });
      page = await context.newPage();
      page.setDefaultTimeout(45_000);
      page.on('pageerror', error => browserErrors.push(error.stack ?? error.message));
      page.on('console', message => browserConsole.push(`${message.type()}: ${message.text()}`));
      return page;
    };
    await openBrowser();
    checkpoint('creator-upload');
    await page!.goto(origin, { waitUntil: 'domcontentloaded' });
    await page!.getByRole('tab', { name: 'Upload', exact: true }).click();
    await page!.waitForFunction(() => (window as any).__originalsDemo?.tier.real === true);
    await page!.getByLabel('Asset title', { exact: true }).fill(`Regtest recovery ${fault}`);
    await page!.locator('input[type=file]').setInputFiles({ name: 'browser-proof.png', mimeType: 'image/png', buffer: Buffer.from(png) });
    await page!.getByRole('button', { name: 'Create asset', exact: true }).click();
    await page!.getByRole('button', { name: 'Publish to web', exact: true }).click();
    await page!.waitForFunction(() => {
      try { return (window as any).__originalsDemo.snapshot().webvhResolved === true; } catch { return false; }
    });
    const hosted = await page!.evaluate(() => {
      const engine = (window as any).__originalsDemo;
      return { assetId: engine.asset.id, webDid: engine.snapshot().webvhDid, head: engine.asset.state.head };
    });
    const cold = () => OriginalsSDK.create({ network: 'regtest', ordinalsProvider: new RegtestProvider(env),
      // Public resolver URLs, not either authenticated/anonymous writer's
      // object API. No cookie or session accompanies these independent reads.
      storageAdapter: {
        async put() { throw new Error('Fresh observer cannot publish'); },
        async get(objectKey: string) {
          const response = await fetch(`https://${objectKey}`);
          if (response.status === 404) return null;
          assert.equal(response.status, 200, `Public hosted read failed: ${objectKey}`);
          return { content: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
        },
      }, enableLogging: false, logging: { level: 'error' } });
    const freshWeb = await cold().lifecycle.resolveAssetFromWeb(hosted.webDid);
    assert.equal(freshWeb.verification.verified, true);
    assert.equal(freshWeb.asset.id, hosted.assetId);
    assert.equal(freshWeb.asset.state.head, hosted.head);
    assert.deepEqual(freshWeb.asset.resources[0].content, png);
    checkpoint('fund-confirmed-deposit', { assetId: hosted.assetId, webDid: hosted.webDid });
    await env.fund(config.fundingAddress);
    // The actual click refreshes the deposit through the production route.
    await page!.getByRole('button', { name: 'Inscribe on Bitcoin', exact: true }).click();
    await page!.locator('.demo-done').waitFor();
    const prepared = await page!.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('originals:bitcoin-publication:')) continue;
        const value = JSON.parse(localStorage.getItem(key)!);
        if (value.format === 'originals/bitcoin-publication') return value;
      }
      throw new Error('Creator did not retain its signed Bitcoin publication');
    }) as PreparedBitcoinPublication;
    const recordBefore = createInscriptionsStore({ dataDir: env.dataDir }).get(config.subOrgId, prepared.transactions.commitTxId);
    assert.ok(recordBefore?.signedCommitHex && recordBefore.revealTxHex);
    assert.equal(recordBefore.signedCommitHex, prepared.transactions.signedCommitHex);
    assert.equal(recordBefore.revealTxHex, prepared.transactions.revealTxHex);
    assert.equal(existsSync(join(env.dataDir, 'browser-fault-fired')), true);
    await page!.locator('section.demo').screenshot({ path: join(artifacts, '01-interrupted.png') });
    const auditPath = join(env.dataDir, 'browser-server-audit.jsonl');
    const readAudit = async () => (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    const signaturesBefore = (await readAudit()).filter(event => event.event === 'sign-request').length;
    assert.ok(signaturesBefore >= 3, 'creator must use actual CEL and Bitcoin signatures');
    await context!.close(); context = undefined; page = undefined;
    await stopApp();
    checkpoint('browser-and-server-stopped', { firstPid, commitTxId: recordBefore.commitTxId, revealTxId: recordBefore.revealTxId });
    await writeFile(join(env.dataDir, 'browser-signing-disabled'), 'No new signatures are permitted after browser/server restart.');
    await env.restart('both');
    config.rpcAuth = env.rpcAuth;
    await writeConfig();
    const secondPid = await startApp();
    assert.notEqual(firstPid, secondPid, 'restart must create a fresh server process');
    const recordAfter = createInscriptionsStore({ dataDir: env.dataDir }).get(config.subOrgId, recordBefore.commitTxId);
    assert.equal(recordAfter?.signedCommitHex, recordBefore.signedCommitHex);
    assert.equal(recordAfter?.revealTxHex, recordBefore.revealTxHex);
    await openBrowser();
    await page!.goto(`${origin}/me`, { waitUntil: 'domcontentloaded' });
    await page!.getByRole('heading', { name: 'Your Originals', exact: true }).waitFor();
    const retainedAfterRestart = await page!.evaluate((commitTxId: string) => {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('originals:bitcoin-publication:')) continue;
        const value = JSON.parse(localStorage.getItem(key)!);
        if (value.transactions?.commitTxId === commitTxId) return value;
      }
      return null;
    }, recordBefore.commitTxId);
    assert.deepEqual(retainedAfterRestart, prepared, 'reopened Chromium retains the exact signed publication on disk');
    const retryResponse = page!.waitForResponse(response => response.url() === `${origin}/api/btc/inscribe/rebroadcast` && response.request().method() === 'POST');
    await page!.getByRole('button', { name: 'Finish inscription', exact: true }).click();
    const retry = await retryResponse;
    assert.equal(retry.status(), 200, await retry.text());
    assert.equal((await retry.json()).status, 'reveal_broadcast');
    await page!.getByRole('button', { name: 'Finish inscription', exact: true }).waitFor({ state: 'hidden' });
    await env.mine();
    await page!.reload({ waitUntil: 'domcontentloaded' });
    await page!.getByText('inscribed ✓', { exact: true }).waitFor();
    await page!.getByText('resolved ✓', { exact: true }).waitFor();
    await page!.screenshot({ path: join(artifacts, '02-recovered.png'), fullPage: true });
    const provider = new RegtestProvider(env);
    const inscription = await provider.getInscriptionById(recordBefore.inscriptionId);
    assert.ok(inscription);
    assert.equal(inscription.contentType, 'image/png');
    assert.deepEqual(inscription.content, png);
    assert.deepEqual(inscription.metadata, prepared.document, 'ord returns the exact browser-signed CEL metadata');
    const accepted = await cold().lifecycle.resolveAssetFromSat(inscription.satoshi);
    assert.equal(accepted.status, 'accepted', JSON.stringify(accepted));
    // The creator includes metadata.json as a second, hosted resource. A sat
    // resolver can reconstruct only the inline PNG, and must disclose that.
    assert.equal(accepted.verification.verified, false);
    assert.deepEqual(accepted.verification.missingResources, [{ id: 'metadata.json', version: 1 }]);
    assert.equal(accepted.asset.id, hosted.assetId);
    assert.deepEqual(accepted.asset.resources[0].content, png);
    const restored = await cold().lifecycle.loadAsset(JSON.stringify(prepared.asset));
    assert.equal(accepted.asset.state.head, restored.asset.state.head, 'cold resolver accepts the exact head signed before the restart');
    const btcoDid = accepted.asset.state.alias;
    assert.equal((await cold().did.resolveDID(btcoDid))?.id, btcoDid);
    const hostedAfter = await cold().lifecycle.resolveAssetFromWeb(hosted.webDid);
    assert.equal(hostedAfter.verification.verified, true);
    assert.equal(hostedAfter.asset.id, hosted.assetId);
    assert.equal(hostedAfter.asset.state.head, hosted.head);
    assert.deepEqual(hostedAfter.asset.resources[0].content, png);
    // Attach only freshly downloaded and independently verified hosted bytes
    // to the freshly accepted chain history. loadAsset authenticates every
    // attachment digest and rechecks the on-sat head; no local creator bytes
    // or stale prepared envelope are used as evidence of availability here.
    const complete = await cold().lifecycle.loadAsset(JSON.stringify({
      ...accepted.asset.serialize(), resources: hostedAfter.asset.serialize().resources,
    }));
    assert.equal(complete.verification.verified, true);
    assert.equal(complete.asset.state.head, accepted.asset.state.head);
    assert.equal(complete.asset.id, hosted.assetId);
    assert.deepEqual(complete.asset.resources[0].content, png);
    const recordConfirmed = createInscriptionsStore({ dataDir: env.dataDir }).get(config.subOrgId, recordBefore.commitTxId);
    assert.equal(recordConfirmed?.status, 'confirmed');
    assert.equal(recordConfirmed.signedCommitHex, recordBefore.signedCommitHex);
    assert.equal(recordConfirmed.revealTxHex, recordBefore.revealTxHex);
    const audit = await readAudit();
    assert.equal(audit.filter(event => event.event === 'sign-request').length, signaturesBefore, 'recovery must not request any fresh signature');
    assert.deepEqual(audit.filter(event => event.event === 'blocked-external-request'), []);
    assert.deepEqual(externalRequests, [], 'browser and server must never fall back to public providers');
    assert.deepEqual(browserErrors, []);
    const broadcasts = audit.filter(event => event.event === 'broadcast');
    for (const event of broadcasts) {
      assert.equal(event.commitTxId, recordBefore.commitTxId);
      assert.equal(event.revealTxId, recordBefore.revealTxId);
      assert.equal(event.rawSha256, digest(Buffer.from(event.kind === 'commit' ? recordBefore.signedCommitHex : recordBefore.revealTxHex, 'hex')));
      assert.equal(event.pairPersisted, true);
    }
    const receipt = { status: 'passed', fault, versions: { ...env.versions, chromium: context!.browser()?.version() ?? 'persistent-context' },
      assetId: hosted.assetId, webDid: hosted.webDid, btcoDid, satoshi: inscription.satoshi,
      head: accepted.asset.state.head, resourceSha256: digest(png), resourceBytes: png.length,
      commitTxId: recordBefore.commitTxId, revealTxId: recordBefore.revealTxId, inscriptionId: recordBefore.inscriptionId,
      commitBytesSha256: digest(Buffer.from(recordBefore.signedCommitHex, 'hex')), revealBytesSha256: digest(Buffer.from(recordBefore.revealTxHex, 'hex')),
      firstServerPid: firstPid, secondServerPid: secondPid, coreAndOrdRestarted: true,
      signaturesBeforeRestart: signaturesBefore, signaturesAfterRestart: 0, broadcasts: broadcasts.length,
      resourceEvidence: { inline: 'browser-proof.png', hosted: 'metadata.json', fullVerification: complete.verification.verified },
      externalRequests, artifacts, completedAt: new Date().toISOString() };
    receipts.push(receipt);
    await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    checkpoint('verified', { inscriptionId: recordBefore.inscriptionId, btcoDid, head: accepted.asset.state.head });
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
      await writeFile(join(artifacts, 'failure.html'), await page.content().catch(() => 'Page unavailable'));
    }
    await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ status: 'failed', fault, error: failureDetail(error), dataDir: env.dataDir, externalRequests, browserErrors }, null, 2) + '\n');
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
    await context?.close();
    await stopApp();
    await env.stop();
    globalThis.fetch = nativeFetch;
    const nodeLogs = (await readdir(env.dataDir)).filter(name => /^(bitcoin|ord)(\.\d+)?(\.error)?\.log$/.test(name));
    for (const file of ['browser-server-audit.jsonl', ...nodeLogs]) {
      try { await copyFile(join(env.dataDir, file), join(artifacts, file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await writeFile(join(artifacts, 'browser-console.log'), browserConsole.join('\n') + '\n');
    await writeFile(join(artifacts, 'events.json'), JSON.stringify(events, null, 2) + '\n');
  }
}
if (!childScenario) await writeFile(join(artifactRoot, 'receipt.json'), JSON.stringify({ status: 'passed', scenarios: receipts }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'passed', receipt: join(artifactRoot, ...(childScenario ? [requested!] : []), 'receipt.json') }));
