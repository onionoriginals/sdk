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
