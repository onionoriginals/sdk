// Throttled-network interactivity check (GRADING.md mechanical floor):
// 1.6 Mbps down / 150ms RTT. Passes if first paint happens and the hero CTA
// is clickable in under 3s.
import { chromium } from 'playwright-core';
import { chromiumExecutablePath } from './browser.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const browser = await chromium.launch({
  executablePath: chromiumExecutablePath()
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8
});
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

const start = Date.now();
await page.goto(url, { waitUntil: 'commit' });
await page.waitForSelector('.hero-headline', { state: 'visible' });
const heroVisible = Date.now() - start;
// clickable = CTA present, enabled, and pointer events land
await page.click('a.btn.btn-primary', { trial: true });
const interactive = Date.now() - start;

const paint = await page.evaluate(() =>
  performance.getEntriesByType('paint').map((p) => `${p.name}=${Math.round(p.startTime)}ms`).join(' ')
);
console.log(`hero visible: ${heroVisible}ms; CTA clickable: ${interactive}ms; ${paint}`);
await browser.close();
if (interactive > 3000) {
  console.error('FAIL: interactive > 3000ms');
  process.exit(1);
}
console.log('PASS: interactive < 3s on throttled connection');
