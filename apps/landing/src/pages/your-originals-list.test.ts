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
  // R20: a signed-in user must never be shown a signed-out or empty state
  // while their own data is still loading. Two distinct wrong states.
  test('loading while auth itself is still resolving — never signed-out', () => {
    expect(
      originalsView({ authLoading: true, authenticated: false, loaded: false, originals: [] }).mode
    ).toBe('loading');
  });
  test('loading while the Originals fetch is in flight — never empty', () => {
    expect(
      originalsView({ authLoading: false, authenticated: true, loaded: false, originals: [] }).mode
    ).toBe('loading');
  });
  test('signed-out mode once auth resolved and nobody is signed in', () => {
    expect(
      originalsView({ authLoading: false, authenticated: false, loaded: false, originals: [] }).mode
    ).toBe('signed-out');
  });
  test('empty mode when authenticated, loaded, and no originals', () => {
    expect(
      originalsView({ authLoading: false, authenticated: true, loaded: true, originals: [] }).mode
    ).toBe('empty');
  });
  test('list mode returns the rows when authenticated with originals', () => {
    const view = originalsView({
      authLoading: false,
      authenticated: true,
      loaded: true,
      originals: rows,
    });
    expect(view.mode).toBe('list');
    expect(view.rows).toEqual(rows);
  });
  test('rows that arrive before `loaded` flips still render — no flash back to loading', () => {
    expect(
      originalsView({ authLoading: false, authenticated: true, loaded: false, originals: rows }).mode
    ).toBe('list');
  });
});

describe('unfinishedInscriptions', () => {
  const NOW = Date.parse('2026-08-18T12:00:00.000Z');
  const rec = (
    status: PendingInscription['status'],
    n: number,
    updatedAt = '2026-08-18T11:59:00.000Z'
  ): PendingInscription => ({
    commitTxId: String(n).repeat(64).slice(0, 64),
    revealTxId: 'r'.repeat(64),
    inscriptionId: `${'r'.repeat(64)}i0`,
    fundingOutpoint: `${'a'.repeat(64)}:0`,
    status,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt,
  });

  test('keeps records whose reveal never broadcast', () => {
    const out = unfinishedInscriptions([
      rec('signed', 1),
      rec('commit_broadcast', 2),
      rec('reveal_broadcast', 3),
      rec('confirmed', 4),
    ], NOW);
    expect(out.map((r) => r.status)).toEqual(['signed', 'commit_broadcast']);
  });

  test('a reveal unconfirmed for hours is offerable — an evicted one has no other manual path', () => {
    const out = unfinishedInscriptions([
      rec('reveal_broadcast', 1, '2026-08-18T11:00:00.000Z'), // 1h — server still auto-retries
      rec('reveal_broadcast', 2, '2026-08-18T02:00:00.000Z'), // 10h — wedged
      rec('confirmed', 3, '2026-08-18T02:00:00.000Z'),        // landed; never offerable
    ], NOW);
    expect(out.map((r) => r.commitTxId[0])).toEqual(['2']);
  });

  test('excludes superseded records — a live rebuilt pair owns their outpoint', () => {
    const out = unfinishedInscriptions([
      { ...rec('signed', 1), superseded: true },
      rec('commit_broadcast', 2),
    ], NOW);
    expect(out.map((r) => r.status)).toEqual(['commit_broadcast']);
  });

  test('empty in, empty out', () => {
    expect(unfinishedInscriptions([])).toEqual([]);
  });
});

describe('withLiveInscriptionStatus', () => {
  test('overlays confirmed from the inscription records by commitTxId', async () => {
    const { withLiveInscriptionStatus } = await import('./YourOriginals');
    const row: OriginalRow = {
      did: 'did:webvh:S:h:studio:you:abc',
      title: 'Piece',
      resourceHash: 'aa',
      createdAt: '2026-08-18T00:00:00.000Z',
      btcoDid: 'did:btco:1',
      commitTxId: 'c'.repeat(64),
      inscriptionStatus: 'pending',
    };
    const rec: PendingInscription = {
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      inscriptionId: `${'r'.repeat(64)}i0`,
      fundingOutpoint: 'a:0',
      status: 'confirmed',
      createdAt: '2026-08-18T00:00:00.000Z',
    };
    const [merged] = withLiveInscriptionStatus([row], [rec]);
    expect(merged.inscriptionStatus).toBe('confirmed');
    // No matching record → row unchanged.
    const [same] = withLiveInscriptionStatus([row], []);
    expect(same.inscriptionStatus).toBe('pending');
  });

  /**
   * `revealBroadcast` exists so the detail page never links a transaction that
   * is not on the network. The commit and reveal are both signed and persisted
   * BEFORE either is broadcast, so `revealTxId` is known while the transaction
   * does not exist — a live mainnet run hit exactly that and got a 404 from an
   * explorer, moments after paying.
   */
  describe('revealBroadcast — which transactions actually exist', () => {
    const row = (extra: Partial<OriginalRow> = {}): OriginalRow => ({
      did: 'did:webvh:S:h:studio:you:abc',
      title: 'Piece',
      resourceHash: 'aa',
      createdAt: '2026-08-18T00:00:00.000Z',
      btcoDid: 'did:btco:1',
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      inscriptionStatus: 'pending',
      ...extra,
    });
    const rec = (status: PendingInscription['status']): PendingInscription => ({
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      inscriptionId: `${'r'.repeat(64)}i0`,
      fundingOutpoint: 'a:0',
      status,
      createdAt: '2026-08-18T00:00:00.000Z',
    });

    test('signed, and commit-only, are NOT broadcast — the reveal must not be linked', async () => {
      const { withLiveInscriptionStatus } = await import('./YourOriginals');
      for (const status of ['signed', 'commit_broadcast'] as const) {
        const [merged] = withLiveInscriptionStatus([row()], [rec(status)]);
        expect(merged.revealBroadcast).toBe(false);
      }
    });

    test('reveal_broadcast and confirmed are on the network', async () => {
      const { withLiveInscriptionStatus } = await import('./YourOriginals');
      for (const status of ['reveal_broadcast', 'confirmed'] as const) {
        const [merged] = withLiveInscriptionStatus([row()], [rec(status)]);
        expect(merged.revealBroadcast).toBe(true);
      }
    });

    test('an already-confirmed row needs no record: its record is retired', async () => {
      const { withLiveInscriptionStatus } = await import('./YourOriginals');
      const [merged] = withLiveInscriptionStatus([row({ inscriptionStatus: 'confirmed' })], []);
      expect(merged.revealBroadcast).toBe(true);
    });

    test('no record and not confirmed leaves it unknown, which reads as not-broadcast', async () => {
      const { withLiveInscriptionStatus } = await import('./YourOriginals');
      const [merged] = withLiveInscriptionStatus([row()], []);
      expect(merged.revealBroadcast).toBeUndefined();
    });
  });
});
