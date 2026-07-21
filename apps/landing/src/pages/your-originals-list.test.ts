import { describe, test, expect } from 'bun:test';
import { originalsView, type OriginalRow } from './YourOriginals';

const rows: OriginalRow[] = [
  {
    did: 'did:webvh:S:demo.example.com:studio:you:abc',
    title: 'First',
    resourceHash: 'deadbeef',
    createdAt: '2026-07-21T00:00:00.000Z',
    resourceUrl: 'https://demo.example.com/studio/you/abc/resources/zR1',
  },
];

describe('originalsView', () => {
  test('signed-out mode when not authenticated', () => {
    expect(originalsView({ authenticated: false, originals: [] }).mode).toBe('signed-out');
  });
  test('empty mode when authenticated with no originals', () => {
    expect(originalsView({ authenticated: true, originals: [] }).mode).toBe('empty');
  });
  test('list mode returns the rows when authenticated with originals', () => {
    const view = originalsView({ authenticated: true, originals: rows });
    expect(view.mode).toBe('list');
    expect(view.rows).toEqual(rows);
  });
});
