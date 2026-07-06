// Browser smoke test: loads the page with ?smoke=1 which runs the full
// real-SDK lifecycle (create → publish → inscribe) in Chromium.
import { chromium } from 'playwright-core';
import { chromiumExecutablePath } from './browser.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/?smoke=1';
const browser = await chromium.launch({
  executablePath: chromiumExecutablePath()
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => {
    const el = document.getElementById('smoke-out');
    return el && el.textContent !== 'booting';
  },
  { timeout: 30000 }
);
const text = await page.textContent('#smoke-out');
console.log('--- smoke output ---');
console.log(text);
console.log('--- console errors ---');
console.log(consoleErrors.length ? consoleErrors.join('\n') : '(none)');
await browser.close();
if (text.includes('ERROR') || consoleErrors.length) process.exit(1);
