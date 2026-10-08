// Builds public/og.png — the 1200×630 social share card (og:image /
// twitter:image). Renders an HTML template in headless Chromium via the
// existing Playwright harness: the eclipse from the landing's hero (drawn here
// as a still SVG, the hero's resting frame) beside the wordmark and the hero
// headline. All copy comes from src/content.ts.
//
// Run with bun (it transpiles the TS imports): bun scripts/og-image.mjs
// Options: --out <path> for the output file. Regenerate when the mark, the
// headline or the eclipse changes.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { chromiumExecutablePath } from './browser.mjs';
import { site, hero } from '../src/content.ts';

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const outPath = fileURLToPath(
  new URL(`../${argValue('--out', 'public/og.png')}`, import.meta.url)
);

const require = createRequire(import.meta.url);
// Inlined: a setContent() page is about:blank and may not load file:// fonts,
// which silently falls back to a system face.
const archivoUrl = `data:font/woff2;base64,${readFileSync(
  join(dirname(require.resolve('@fontsource-variable/archivo/package.json')), 'files', 'archivo-latin-wdth-normal.woff2')
).toString('base64')}`;

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Corona streaks: deterministic (seeded LCG), brighter toward the diamond.
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const R = 150, DIAMOND = -Math.PI / 4.2;
const streaks = Array.from({ length: 900 }, () => {
  const a = rand() * Math.PI * 2, d = 1 + rand() * 0.7;
  const near = Math.cos(a - DIAMOND) * 0.5 + 0.5;
  const alpha = (1 - (d - 1) / 0.75) * (0.08 + near * 0.26);
  const r2 = d + 0.05 + near * 0.05;
  const p = (k) => `${(Math.cos(a) * R * k).toFixed(1)} ${(Math.sin(a) * R * k).toFixed(1)}`;
  return `<path d="M${p(d)}L${p(r2)}" stroke="rgb(255,${(150 + near * 60) | 0},${(60 + near * 40) | 0})" stroke-opacity="${Math.max(0, alpha).toFixed(3)}" stroke-width="${(0.6 + rand()).toFixed(2)}"/>`;
}).join('');
const sx = (Math.cos(DIAMOND) * R).toFixed(1), sy = (Math.sin(DIAMOND) * R).toFixed(1);
const L = R * 0.62, w = R * 0.022;
const eclipse = `<svg viewBox="-300 -300 600 600" width="600" height="600" aria-hidden="true">
  <defs>
    <radialGradient id="halo"><stop offset=".5" stop-color="#ff9632" stop-opacity=".26"/><stop offset="1" stop-color="#ff781e" stop-opacity="0"/></radialGradient>
    <radialGradient id="bloom"><stop offset="0" stop-color="#ffbe6e" stop-opacity=".75"/><stop offset=".4" stop-color="#ff8c28" stop-opacity=".3"/><stop offset="1" stop-color="#ff781e" stop-opacity="0"/></radialGradient>
  </defs>
  <circle r="${R * 1.9}" fill="url(#halo)"/>
  <g style="mix-blend-mode:screen">${streaks}</g>
  <circle r="${R}" fill="#07080b"/>
  <circle r="${R}" fill="none" stroke="#f6f3ec" stroke-width="${(R * 0.028).toFixed(1)}"/>
  <circle cx="${sx}" cy="${sy}" r="${R * 0.5}" fill="url(#bloom)"/>
  <path fill="#fff" d="M${+sx + L} ${sy}L${sx} ${+sy + w}L${+sx - L} ${sy}L${sx} ${+sy - w}Z M${sx} ${+sy - L * 0.82}L${+sx + w} ${sy}L${sx} ${+sy + L * 0.82}L${+sx - w} ${sy}Z"/>
  <circle cx="${sx}" cy="${sy}" r="${R * 0.04}" fill="#fff"/>
</svg>`;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Archivo Variable';
    src: url('${archivoUrl}') format('woff2-variations');
    font-weight: 100 900; font-stretch: 62% 125%;
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden; position: relative;
    background: #07080b; color: #f3f1ec; font-family: 'Archivo Variable', sans-serif;
  }
  .art { position: absolute; top: 15px; right: -40px; }
  .copy { position: absolute; inset: 0; padding: 72px 80px; display: flex; flex-direction: column; }
  .wordmark { display: flex; align-items: center; gap: 18px; font-stretch: 125%; font-weight: 800; font-size: 22px; letter-spacing: .32em; }
  .wordmark svg { width: 34px; height: 34px; }
  .headline {
    margin-top: auto; max-width: 600px;
    font-stretch: 125%; font-weight: 800; text-transform: uppercase;
    font-size: 72px; line-height: 1; letter-spacing: -.005em;
  }
</style>
<body>
  <div class="art">${eclipse}</div>
  <div class="copy">
    <div class="wordmark">
      <svg viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="10" cy="12" r="7.4" fill="none" stroke="#f3f1ec" stroke-width="2.2"/>
        <circle cx="16.3" cy="5.7" r="3.3" fill="#ffa63d"/>
      </svg>
      <span>${esc(site.wordmark.toUpperCase())}</span>
    </div>
    <div class="headline">${esc(hero.headline)}</div>
  </div>
</body>`;

const browser = await chromium.launch({ executablePath: chromiumExecutablePath() });
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1
});
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(`og-image: wrote ${outPath} (1200×630)`);
