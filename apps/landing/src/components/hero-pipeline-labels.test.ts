/**
 * The landing introduction uses plain-language history labels, not DID names. A
 * first-time visitor should read "Private draft", not "did:cel", before the
 * page has explained either. The demo's pipeline keeps the names.
 */
import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordLine } from './RecordLine';

async function read(file: string): Promise<string> {
  return Bun.file(new URL(`./${file}`, import.meta.url)).text();
}

describe('landing history and pipeline labels', () => {
  test('the introduction shows plain-language events and identifies its illustrative history', () => {
    const markup = renderToStaticMarkup(createElement(RecordLine));
    for (const label of ['Created', 'Revised', 'Published']) {
      expect(markup).toContain(`<h3>${label}</h3>`);
    }
    expect(markup).toContain('Example history, not live transactions.');
    expect(markup).not.toMatch(/did:(cel|webvh|btco)/);
  });

  test('Pipeline only renders the name label when showNames is on', async () => {
    const pipeline = await read('Pipeline.tsx');
    expect(pipeline).toContain('{showNames && <span className="pipeline-name">');
    // The flag is visible to CSS so the narrow-screen rule below can key on it.
    expect(pipeline).toContain('data-names-hidden');
  });

  test('narrow screens keep the role label when the names are off', async () => {
    const css = await read('pipeline.css');
    // Baseline: mobile hides the role in favour of the name…
    expect(css).toMatch(/\.pipeline-role\s*\{\s*display:\s*none;\s*\}/);
    // …so without a name the role must come back, or the node has no label.
    expect(css).toMatch(/\.pipeline\[data-names-hidden\]\s+\.pipeline-role\s*\{\s*display:\s*block;\s*\}/);
  });

  test('the demo pipeline keeps its names', async () => {
    const demo = await read('Demo.tsx');
    expect(demo).not.toContain('showNames={false}');
  });
});
