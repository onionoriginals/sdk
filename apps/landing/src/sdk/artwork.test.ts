/**
 * LANDING-004 — generateArtwork.
 *
 * The artwork IS the demo asset's bytes: it is hashed into the resource, that
 * hash is signed into the did:cel genesis, and the detail page re-hashes the
 * served bytes to verify. So determinism is not a nicety — a generator that
 * drifted for the same inputs would break verification, and nothing was
 * asserting it.
 */
import { describe, test, expect } from 'bun:test';
import { generateArtwork } from './artwork';

const MEDIA = ['Music', 'Dataset', 'Writing', 'Photography'] as const;

describe('generateArtwork', () => {
  test('is deterministic for the same title/medium/nonce', () => {
    const a = generateArtwork('First Light', 'Photography', 7);
    const b = generateArtwork('First Light', 'Photography', 7);

    expect(a.svg).toBe(b.svg);
    expect(a.dataUri).toBe(b.dataUri);
    expect(a.palette).toEqual(b.palette);
  });

  test('every input component changes the output', () => {
    const base = generateArtwork('First Light', 'Photography', 7).svg;

    expect(generateArtwork('Second Light', 'Photography', 7).svg).not.toBe(base);
    expect(generateArtwork('First Light', 'Writing', 7).svg).not.toBe(base);
    expect(generateArtwork('First Light', 'Photography', 8).svg).not.toBe(base);
  });

  test('consecutive nonces stay distinct across a run of seeds', () => {
    const seen = new Set<string>();
    for (let nonce = 0; nonce < 40; nonce++) {
      seen.add(generateArtwork('Untitled', 'Photography', nonce).svg);
    }
    expect(seen.size).toBe(40);
  });

  test.each(MEDIA)('produces a standalone, well-formed SVG document for %s', (medium) => {
    const { svg, dataUri, palette } = generateArtwork('Untitled', medium, 3);

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('viewBox="0 0 ');
    // Balanced tags — a truncated body would still "start with <svg".
    expect(svg.split('<svg').length).toBe(2);
    expect(svg.split('</svg>').length).toBe(2);

    expect(palette).toHaveLength(2);
    for (const colour of palette) expect(colour).toMatch(/^#[0-9a-fA-F]{3,8}$/);

    expect(dataUri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(dataUri.slice('data:image/svg+xml;charset=utf-8,'.length))).toBe(svg);
  });

  test('medium selects a distinct generator, not just a distinct seed', () => {
    // Dataset is the dot-grid branch and deliberately omits the core circles.
    expect(generateArtwork('X', 'Dataset', 1).svg).toContain('<circle');
    expect(generateArtwork('X', 'Dataset', 1).svg).not.toContain('fill="url(#g)"');
    expect(generateArtwork('X', 'Photography', 1).svg).toContain('fill="url(#g)"');
  });

  test('transparent omits the opaque backdrop but keeps the body', () => {
    const solid = generateArtwork('X', 'Photography', 1);
    const clear = generateArtwork('X', 'Photography', 1, { transparent: true });

    expect(solid.svg).toContain('fill="#0b0d13"');
    expect(clear.svg).not.toContain('<rect');
    expect(clear.svg).not.toContain('url(#glow)');
    // Same seed, so the generated body is unchanged — only the backdrop differs.
    expect(clear.svg.length).toBeLessThan(solid.svg.length);
    expect(clear.palette).toEqual(solid.palette);
  });

  test('the title is XML-escaped, so it cannot break out of the <title> element', () => {
    const { svg } = generateArtwork('<script>alert("x")</script> & co', 'Writing', 1);

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp; co');
    expect(svg).toContain('&quot;');
    // Still exactly one title element.
    expect(svg.split('<title>').length).toBe(2);
  });

  test('an empty title still yields a valid document', () => {
    const { svg } = generateArtwork('', 'Writing', 0);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });
});
