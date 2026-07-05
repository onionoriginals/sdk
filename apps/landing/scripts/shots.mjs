// Capture full-page + section screenshots at desktop and mobile widths.
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:4173/';
const outDir = process.argv[3] ?? 'shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const consoleErrors = [];
for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 375, height: 812 }]
]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${name} pageerror: ${e.message}`));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/${name}-hero.png` });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1200); // let reveals fire
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${name}-full.png`, fullPage: true });
  await page.close();
}
console.log('console errors:', consoleErrors.length ? consoleErrors : '(none)');
await browser.close();
