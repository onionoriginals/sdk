import { describe, test, expect } from 'bun:test';
import {
  originalsView,
  unfinishedInscriptions,
  type OriginalRow,
  type PendingInscription,
} from './YourOriginals';

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

describe('unfinishedInscriptions', () => {
  const rec = (status: PendingInscription['status'], n: number): PendingInscription => ({
    commitTxId: String(n).repeat(64).slice(0, 64),
    revealTxId: 'r'.repeat(64),
    inscriptionId: `${'r'.repeat(64)}i0`,
    fundingOutpoint: `${'a'.repeat(64)}:0`,
    status,
    createdAt: '2026-08-18T00:00:00.000Z',
  });

  test('keeps only records whose reveal never broadcast', () => {
    const out = unfinishedInscriptions([
      rec('signed', 1),
      rec('commit_broadcast', 2),
      rec('reveal_broadcast', 3),
      rec('confirmed', 4),
    ]);
    expect(out.map((r) => r.status)).toEqual(['signed', 'commit_broadcast']);
  });

  test('empty in, empty out', () => {
    expect(unfinishedInscriptions([])).toEqual([]);
  });
});
