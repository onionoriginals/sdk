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
import { generateArtwork, generateName, ART_STYLES } from './artwork';

const STYLES = ['Radial Bars', 'Dot Grid', 'Constellation', 'Orbits'] as const;

describe('generateArtwork', () => {
  test('is deterministic for the same title/style/nonce', () => {
    const a = generateArtwork('First Light', 'Orbits', 7);
    const b = generateArtwork('First Light', 'Orbits', 7);

    expect(a.svg).toBe(b.svg);
    expect(a.dataUri).toBe(b.dataUri);
    expect(a.palette).toEqual(b.palette);
  });

  test('every input component changes the output', () => {
    const base = generateArtwork('First Light', 'Orbits', 7).svg;

    // The title reaches the bytes through the SVG's <title> element even though
    // it no longer seeds the picture — so it still changes what gets hashed.
    expect(generateArtwork('Second Light', 'Orbits', 7).svg).not.toBe(base);
    expect(generateArtwork('First Light', 'Constellation', 7).svg).not.toBe(base);
    expect(generateArtwork('First Light', 'Orbits', 8).svg).not.toBe(base);
  });

  test('the picture is seeded by style and nonce alone, so typing a name never reshuffles it', () => {
    const strip = (svg: string) => svg.replace(/<title>[\s\S]*?<\/title>/, '');

    expect(strip(generateArtwork('First Light', 'Orbits', 7).svg)).toBe(
      strip(generateArtwork('A Totally Different Name', 'Orbits', 7).svg)
    );
  });

  test('consecutive nonces stay distinct across a run of seeds', () => {
    const seen = new Set<string>();
    for (let nonce = 0; nonce < 40; nonce++) {
      seen.add(generateArtwork('Untitled', 'Orbits', nonce).svg);
    }
    expect(seen.size).toBe(40);
  });

  test.each(STYLES)('produces a standalone, well-formed SVG document for %s', (style) => {
    const { svg, dataUri, palette } = generateArtwork('Untitled', style, 3);

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

  test('style selects a distinct generator, not just a distinct seed', () => {
    // Dot Grid is its own branch and deliberately omits the core circles.
    expect(generateArtwork('X', 'Dot Grid', 1).svg).toContain('<circle');
    expect(generateArtwork('X', 'Dot Grid', 1).svg).not.toContain('fill="url(#g)"');
    expect(generateArtwork('X', 'Orbits', 1).svg).toContain('fill="url(#g)"');
  });

  test('every named style renders, and no two draw the same picture', () => {
    const bodies = ART_STYLES.map((style) =>
      generateArtwork('X', style, 1).svg.replace(/<title>[\s\S]*?<\/title>/, '')
    );
    expect(new Set(bodies).size).toBe(ART_STYLES.length);
  });

  test('transparent omits the opaque backdrop but keeps the body', () => {
    const solid = generateArtwork('X', 'Orbits', 1);
    const clear = generateArtwork('X', 'Orbits', 1, { transparent: true });

    expect(solid.svg).toContain('fill="#0b0d13"');
    expect(clear.svg).not.toContain('<rect');
    expect(clear.svg).not.toContain('url(#glow)');
    // Same seed, so the generated body is unchanged — only the backdrop differs.
    expect(clear.svg.length).toBeLessThan(solid.svg.length);
    expect(clear.palette).toEqual(solid.palette);
  });

  test('the title is XML-escaped, so it cannot break out of the <title> element', () => {
    const { svg } = generateArtwork('<script>alert("x")</script> & co', 'Constellation', 1);

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp; co');
    expect(svg).toContain('&quot;');
    // Still exactly one title element.
    expect(svg.split('<title>').length).toBe(2);
  });

  test('an empty title still yields a valid document', () => {
    const { svg } = generateArtwork('', 'Constellation', 0);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
  });
});

/**
 * The generated title. Paired with the picture by construction: one seed names
 * the piece and draws it, so Regenerate moves both together.
 */
describe('generateName', () => {
  test('is deterministic for the same style and nonce', () => {
    expect(generateName('Orbits', 7)).toBe(generateName('Orbits', 7));
  });

  test('a new nonce gives a new name', () => {
    const names = new Set(Array.from({ length: 40 }, (_, n) => generateName('Orbits', n)));
    // Not 40: the word lists collide by design at this size. Enough variety
    // that a visitor pressing the button sees a different name, not a fixed one.
    expect(names.size).toBeGreaterThan(30);
  });

  test('reads as a title — two words and a number, no placeholder tells', () => {
    for (const style of ART_STYLES) {
      expect(generateName(style, 3)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ #\d{3}$/);
    }
  });
});

/**
 * The naming rule the UI implements: a new name arrives WITH new art, and only
 * then. The check is "is the title still what this (style, nonce) generates" —
 * no dirty flag, so a typed title is never overwritten and a restored one is
 * recognised as generated again.
 */
describe('generated titles track the artwork', () => {
  const isGenerated = (title: string, style: string, nonce: number) =>
    title === generateName(style, nonce);

  test('a freshly generated title is recognised as generated', () => {
    expect(isGenerated(generateName('Orbits', 7), 'Orbits', 7)).toBe(true);
  });

  test('a title the visitor typed is not, so it survives a regenerate', () => {
    expect(isGenerated('My Own Name', 'Orbits', 7)).toBe(false);
  });

  test('new art means a new name: bumping the nonce changes what would be generated', () => {
    expect(generateName('Orbits', 7)).not.toBe(generateName('Orbits', 8));
  });

  test('a new style is new art too, so it renames as well', () => {
    expect(generateName('Orbits', 7)).not.toBe(generateName('Dot Grid', 7));
  });

  test('restoring a committed (style, nonce) restores a title recognised as generated', () => {
    // Discard/Start over put back a prior pair; the restored title must be seen
    // as generated again, or the next regenerate would refuse to rename it.
    const restored = generateName('Constellation', 42);
    expect(isGenerated(restored, 'Constellation', 42)).toBe(true);
  });
});
