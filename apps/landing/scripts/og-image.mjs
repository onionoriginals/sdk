// Builds public/og.png — the 1200×630 social share card (og:image /
// twitter:image). Renders an HTML template in headless Chromium via the
// existing Playwright harness: one of the site's real generative artworks
// (src/sdk/artwork.ts, the same program the demo inscribes) beside the
// wordmark and tagline. All copy comes from src/content.ts.
//
// Run with bun (it transpiles the TS imports): bun scripts/og-image.mjs
// Options: --nonce <n> to try a different artwork, --out <path> for the
// output file. The committed og.png was generated with the defaults below;
// regenerate only when the icon, copy, or artwork generator changes.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { chromiumExecutablePath } from './browser.mjs';
import { generateArtwork } from '../src/sdk/artwork.ts';
import { site, footer } from '../src/content.ts';

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

// Fixed seed → deterministic bytes; nonce 11 picked by eye (amber/violet
// palette — the amber core echoes the favicon ring against the dark ground).
const NONCE = Number(argValue('--nonce', '11'));
const outPath = fileURLToPath(
  new URL(`../${argValue('--out', 'public/og.png')}`, import.meta.url)
);

const { svg } = generateArtwork(site.wordmark, 'Artwork', NONCE, { transparent: true });

const require = createRequire(import.meta.url);
const fontUrl = (pkg, file) =>
  pathToFileURL(join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file)).href;
const interUrl = fontUrl('@fontsource-variable/inter', 'inter-latin-wght-normal.woff2');
const monoUrl = fontUrl('@fontsource/jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2');

// footer.bottomRight is the canonical "did:peer → did:webvh → did:btco"
// string; color each layer with its hue from the site's palette.
const layerHues = ['#a78bfa', '#4cc2ff', '#f7931a'];
const chain = footer.bottomRight
  .split(' → ')
  .map((seg, i) => `<span style="color:${layerHues[i] ?? '#828a9a'}">${seg}</span>`)
  .join('<span class="arrow"> → </span>');

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Inter Variable';
    src: url('${interUrl}') format('woff2-variations');
    font-weight: 100 900;
  }
  @font-face {
    font-family: 'JetBrains Mono';
    src: url('${monoUrl}') format('woff2');
    font-weight: 400;
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background: #08090c;
    font-family: 'Inter Variable', sans-serif;
    color: #f4f5f7;
    position: relative;
  }
  .glow {
    position: absolute; inset: 0;
    background:
      radial-gradient(640px 640px at 900px 315px, rgba(76, 194, 255, 0.10), transparent 70%),
      radial-gradient(760px 560px at 160px 560px, rgba(247, 147, 26, 0.07), transparent 70%);
  }
  .art {
    position: absolute; top: 50%; right: -128px;
    width: 760px; height: 760px;
    transform: translateY(-50%);
  }
  .art svg { width: 100%; height: 100%; }
  .copy {
    position: absolute; inset: 0;
    padding: 76px 80px;
    display: flex; flex-direction: column;
  }
  .wordmark { display: flex; align-items: center; gap: 16px; }
  .wordmark svg { width: 46px; height: 46px; }
  .wordmark span { font-size: 38px; font-weight: 620; letter-spacing: -0.02em; }
  .tagline {
    margin-top: auto;
    max-width: 660px;
    font-size: 67px; line-height: 1.08; font-weight: 640;
    letter-spacing: -0.028em;
    /* fade the right edge slightly where it approaches the artwork */
    text-shadow: 0 2px 24px rgba(8, 9, 12, 0.9);
  }
  .chain {
    margin-top: 40px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 25px; letter-spacing: 0.01em;
  }
  .arrow { color: #828a9a; }
</style>
<body>
  <div class="glow"></div>
  <div class="art">${svg}</div>
  <div class="copy">
    <div class="wordmark">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7.25" fill="none" stroke="#f7931a" stroke-width="2.5"/>
        <circle cx="10" cy="10" r="2" fill="#f4f5f7"/>
      </svg>
      <span>${site.wordmark}</span>
    </div>
    <div class="tagline">${site.tagline}</div>
    <div class="chain">${chain}</div>
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
console.log(`og-image: wrote ${outPath} (1200×630, nonce ${NONCE})`);
