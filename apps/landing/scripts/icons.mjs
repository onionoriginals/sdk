// Generates public/favicon.ico (16/32/48 PNG entries) and
// public/apple-touch-icon.png (180×180) by rasterizing the inline SVG icon
// in index.html — the SVG stays the single source of truth. Run after
// changing that icon: bun scripts/icons.mjs (node works too).
//
// The .ico is packed by hand with PNG-compressed entries (supported by every
// current browser and by Windows since Vista) to keep the app free of extra
// build dependencies.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromiumExecutablePath } from './browser.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const html = readFileSync(root('index.html'), 'utf8');
const match = html.match(/href="data:image\/svg\+xml,([^"]+)"/);
if (!match) {
  console.error('icons: could not find the inline SVG icon data URI in index.html');
  process.exit(1);
}
const svg = decodeURIComponent(match[1]);

const browser = await chromium.launch({ executablePath: chromiumExecutablePath() });

async function rasterize(size, { background = null, scale = 1 } = {}) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1
  });
  const inner = Math.round(size * scale);
  const pad = Math.round((size - inner) / 2);
  await page.setContent(
    `<!doctype html><style>
       html,body{margin:0;width:${size}px;height:${size}px;
         background:${background ?? 'transparent'}}
       svg{display:block;width:${inner}px;height:${inner}px;margin:${pad}px}
     </style>${svg}`
  );
  const png = await page.screenshot({
    omitBackground: background === null,
    clip: { x: 0, y: 0, width: size, height: size }
  });
  await page.close();
  return png;
}

function packIco(pngs) {
  const headerSize = 6 + 16 * pngs.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = headerSize;
  pngs.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size === 256 ? 0 : size, entry); // width
    header.writeUInt8(size === 256 ? 0 : size, entry + 1); // height
    header.writeUInt8(0, entry + 2); // palette colors
    header.writeUInt8(0, entry + 3); // reserved
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.png)]);
}

const sizes = [16, 32, 48];
const entries = [];
for (const size of sizes) {
  entries.push({ size, png: await rasterize(size) });
}
writeFileSync(root('public/favicon.ico'), packIco(entries));

// iOS composites no transparency and adds its own corner radius: opaque
// theme-color background, icon at ~62% so the ring keeps breathing room.
writeFileSync(
  root('public/apple-touch-icon.png'),
  await rasterize(180, { background: '#08090c', scale: 0.62 })
);

await browser.close();
console.log(`icons: wrote public/favicon.ico (${sizes.join('/')}) and public/apple-touch-icon.png (180)`);
