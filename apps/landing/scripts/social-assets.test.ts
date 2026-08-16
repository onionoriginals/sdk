/**
 * LANDING-007 / LANDING-008 — the committed social card and icons.
 *
 * `og-image.mjs` and `icons.mjs` need headless Chromium, so running the
 * generators is not a hermetic unit test. What actually breaks in production is
 * not the generator, it is the COMMITTED OUTPUT drifting from what index.html
 * promises: a card whose real dimensions no longer match the declared
 * og:image:width/height is silently cropped or rejected by every social
 * scraper, and a truncated icon is a broken tab. Previously nothing checked
 * either — the doc's own note was "verified only by manually running the script
 * and inspecting output".
 *
 * These assert the artifacts are real, well-formed, correctly sized, and
 * referenced by the HTML that ships beside them.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p: string) => readFileSync(root(p));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width/height from a PNG's IHDR chunk (always the first chunk). */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8)).toEqual(PNG_MAGIC);
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const indexHtml = readFileSync(root('index.html'), 'utf8');

describe('og.png — the social share card', () => {
  test('is a real PNG at exactly the dimensions index.html declares', () => {
    const png = read('public/og.png');
    const { width, height } = pngSize(png);

    expect(width).toBe(1200);
    expect(height).toBe(630);

    // The declared meta must match the file, or scrapers crop/reject the card.
    expect(indexHtml).toContain('<meta property="og:image:width" content="1200" />');
    expect(indexHtml).toContain('<meta property="og:image:height" content="630" />');
  });

  test('is referenced as both og:image and twitter:image, with alt text', () => {
    expect(indexHtml).toMatch(/property="og:image"\s+content="[^"]*\/og\.png"/);
    expect(indexHtml).toMatch(/name="twitter:image"\s+content="[^"]*\/og\.png"/);
    expect(indexHtml).toContain('og:image:alt');
    expect(indexHtml).toContain('twitter:image:alt');
  });

  test('is a plausibly rendered card, not a blank or truncated file', () => {
    const png = read('public/og.png');
    // A 1200×630 render of the card is ~100KB+; a blank fill compresses to a
    // few KB, and a truncated write would not carry an IEND chunk.
    expect(png.byteLength).toBeGreaterThan(50_000);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });
});

describe('favicon + apple-touch-icon', () => {
  test('the inline SVG icon — the single source of truth — is present in index.html', () => {
    const match = indexHtml.match(/href="data:image\/svg\+xml,([^"]+)"/);
    expect(match).not.toBeNull();
    const svg = decodeURIComponent(match![1]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  test('apple-touch-icon.png is a real 180×180 PNG and is linked', () => {
    const { width, height } = pngSize(read('public/apple-touch-icon.png'));
    expect(width).toBe(180);
    expect(height).toBe(180);
    expect(indexHtml).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
  });

  test('favicon.ico carries the 16/32/48 PNG entries the generator packs', () => {
    const ico = read('public/favicon.ico');

    // ICONDIR: reserved=0, type=1 (icon), count.
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBe(3);

    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const width = ico.readUInt8(entry) || 256;
      const height = ico.readUInt8(entry + 1) || 256;
      expect(width).toBe(height);
      sizes.push(width);

      // Each entry must point at a real, in-bounds PNG payload.
      const bytes = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset + bytes).toBeLessThanOrEqual(ico.byteLength);
      const payload = ico.subarray(offset, offset + bytes);
      expect(payload.subarray(0, 8)).toEqual(PNG_MAGIC);
      expect(pngSize(payload)).toEqual({ width, height });
    }
    expect(sizes).toEqual([16, 32, 48]);

    expect(indexHtml).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />');
  });
});
