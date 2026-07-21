import { describe, test, expect } from 'bun:test';
import { DemoEngine } from './engine';
import { demo } from '../content';

describe('honesty labels', () => {
  test('content: create step no longer claims a did:peer identity', () => {
    expect(demo.steps[0].description).toContain('did:cel');
    expect(demo.steps[0].description).not.toContain('did:peer identity');
  });

  test('content: publish step describes real hosting/resolution', () => {
    expect(demo.steps[1].description.toLowerCase()).toMatch(/host|resolv/);
  });

  test('asset:created summary says did:cel, not "a private did:peer identity"', async () => {
    const engine = new DemoEngine();
    const summaries: string[] = [];
    engine.on((e) => {
      if (e.type === 'asset:created') summaries.push(e.summary);
    });
    await engine.create('Test Piece', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain('did:cel');
    expect(summaries[0]).not.toContain('did:peer identity');
  });
});
