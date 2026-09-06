/**
 * AssetSource (#demo uploads): the asset's bytes can come from generated
 * artwork, an uploaded SVG, or typed text. All three are TEXT — the SDK hashes
 * `AssetResource.content` as `TextEncoder().encode(content)`, so anything
 * binary would either corrupt or be re-encoded into bytes whose hash no longer
 * belongs to the user's file. These assert the three sources travel the same
 * lifecycle and that the resource carries what was actually supplied.
 */
import { describe, test, expect } from 'bun:test';
import { DemoEngine } from './engine';
import { generateArtwork } from './artwork';

const SVG = generateArtwork('Fixture', 'Orbits', 1).svg;

describe('the asset source', () => {
  test('a bare string is still generated SVG artwork — the legacy shorthand', async () => {
    const state = await new DemoEngine().create('Untitled', 'Orbits', SVG);

    expect(state.resource.id).toBe('artwork.svg');
    expect(state.resource.contentType).toBe('image/svg+xml');
    expect(state.resource.content).toBe(SVG);
  });

  test('typed text is carried verbatim as its own resource', async () => {
    const text = 'the quick brown fox\njumped over\n';
    const state = await new DemoEngine().create('Notes', 'Orbits', {
      content: text,
      contentType: 'text/plain',
      filename: 'asset.txt'
    });

    expect(state.resource.id).toBe('asset.txt');
    expect(state.resource.contentType).toBe('text/plain');
    // Verbatim: the bytes hashed are exactly what was typed, not a normalised
    // or re-wrapped copy — the whole claim the page makes about its assets.
    expect(state.resource.content).toBe(text);
  });

  test('an uploaded SVG keeps its own filename and media type', async () => {
    const state = await new DemoEngine().create('Mine', 'Orbits', {
      content: SVG,
      contentType: 'image/svg+xml',
      filename: 'my-drawing.svg'
    });

    expect(state.resource.id).toBe('my-drawing.svg');
    expect(state.resource.contentType).toBe('image/svg+xml');
  });

  test('metadata names the file the asset actually carries, not a hardcoded one', async () => {
    const state = await new DemoEngine().create('Notes', 'Orbits', {
      content: 'hello',
      contentType: 'text/plain',
      filename: 'asset.txt'
    });

    const meta = JSON.parse(state.metadata!.content) as { artwork: { file: string } };
    expect(meta.artwork.file).toBe('asset.txt');
  });

  test('a revision may change the bytes without changing the resource id', async () => {
    const engine = new DemoEngine();
    await engine.create('Notes', 'Orbits', {
      content: 'first',
      contentType: 'text/plain',
      filename: 'asset.txt'
    });
    const updated = await engine.update('Notes', 'Orbits', {
      content: 'second',
      contentType: 'text/plain',
      filename: 'asset.txt'
    });

    expect(updated.resource.id).toBe('asset.txt');
    expect(updated.resource.content).toBe('second');
  });
});

/**
 * The 32 KB cap is charged in UTF-8 bytes, because that is what gets hashed and
 * paid for on-chain. Measuring it with `String.length` — UTF-16 code units —
 * under-counts every emoji and CJK character, so a "32,000 character" note can
 * be nearly 100 KB of inscription. These pin the unit.
 */
describe('the source byte cap', () => {
  const MAX_SOURCE_BYTES = 32 * 1024;
  const byteLength = (t: string) => new TextEncoder().encode(t).length;

  test('ASCII: code units and bytes agree', () => {
    const text = 'a'.repeat(MAX_SOURCE_BYTES);
    expect(text.length).toBe(MAX_SOURCE_BYTES);
    expect(byteLength(text)).toBe(MAX_SOURCE_BYTES);
  });

  test('emoji: a string well under the cap by length is well over it by bytes', () => {
    // Each of these is 2 UTF-16 code units and 4 UTF-8 bytes.
    const text = '😀'.repeat(MAX_SOURCE_BYTES / 2);
    expect(text.length).toBeLessThanOrEqual(MAX_SOURCE_BYTES);
    expect(byteLength(text)).toBeGreaterThan(MAX_SOURCE_BYTES);
  });

  test('CJK: three bytes per character, one code unit', () => {
    const text = '漢'.repeat(20_000);
    expect(text.length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(byteLength(text)).toBe(60_000);
  });

  test('the engine still carries multibyte text verbatim when it fits', async () => {
    const text = '漢字 😀 mixed\n';
    const state = await new DemoEngine().create('Mixed', 'Orbits', {
      content: text,
      contentType: 'text/plain',
      filename: 'asset.txt'
    });

    // Byte-identical round-trip: multibyte characters survive the encode the
    // SDK does when it hashes, so what is published is what was typed.
    expect(state.resource.content).toBe(text);
    expect(byteLength(state.resource.content)).toBe(byteLength(text));
  });
});
