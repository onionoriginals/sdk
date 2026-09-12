/**
 * Direct unit tests for the extracted reconciliation state machine (#497) —
 * cursor rotation, per-poll lookup budget, and status transitions, exercised
 * against `createInscriptionReconciler` itself rather than only reachable
 * through `createBitcoinRoutes`'s HTTP handler. A fake status provider makes
 * these fast and focused: no signed transactions, no route/auth plumbing.
 *
 * `inscribe-routes.test.ts` already proves this behavior end-to-end through
 * the real routes with real signed pairs; these tests pin the same
 * cursor/budget/status contract at the module boundary so it stays covered
 * even if the HTTP wiring around it changes.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInscriptionsStore, type InscriptionRecord } from '../inscriptions-store';
import { createMoneyLogger } from '../money-log';
import { createInscriptionReconciler, rotate, type ReconciliationProvider } from '../bitcoin-reconciliation';

const rec = (over: Partial<InscriptionRecord> & { commitTxId: string }): InscriptionRecord => ({
  revealTxId: `${over.commitTxId.slice(0, 62)}r0`,
  inscriptionId: `${over.commitTxId}i0`,
  signedCommitHex: '02aa',
  revealTxHex: '02bb',
  fundingOutpoints: [`${over.commitTxId}:0`],
  changeAddress: 'tb1qexample',
  status: 'signed',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const silentMoney = createMoneyLogger(() => {}, () => 0);

function harness(opts?: {
  txStatus?: (txid: string) => { confirmed: boolean; confirmations?: number } | undefined;
  broadcastFails?: boolean;
  now?: () => number;
  recoveryConfirmations?: number;
  revealRebroadcastAfterMs?: number;
}) {
  const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'recon-')) });
  const broadcastCalls: string[] = [];
  const provider: ReconciliationProvider = {
    async getTransactionStatus(txid: string) {
      return opts?.txStatus?.(txid) ?? { confirmed: false };
    },
  };
  const broadcastIdempotent = async (txHex: string | undefined): Promise<string | null> => {
    if (!txHex) return 'no recovery artifact for this record';
    broadcastCalls.push(txHex);
    return opts?.broadcastFails ? 'rejected' : null;
  };
  const reconciler = createInscriptionReconciler({
    store,
    provider,
    broadcastIdempotent,
    unreadableRecords: () => null,
    money: silentMoney,
    now: opts?.now ?? (() => 0),
    recoveryConfirmations: opts?.recoveryConfirmations,
    revealRebroadcastAfterMs: opts?.revealRebroadcastAfterMs,
  });
  return { store, reconciler, broadcastCalls };
}

async function listOf(reconciler: ReturnType<typeof harness>['reconciler'], sub: string) {
  const res = await reconciler.reconcileUser(sub);
  return (await res.json()) as { inscriptions: Array<{ commitTxId: string; status: string; superseded?: boolean }> };
}

describe('rotate', () => {
  test('empty array is returned as-is', () => {
    const arr: number[] = [];
    expect(rotate(arr, 5)).toBe(arr);
  });

  test('starts at cursor % length and wraps', () => {
    expect(rotate([1, 2, 3, 4], 1)).toEqual([2, 3, 4, 1]);
    expect(rotate([1, 2, 3, 4], 4)).toEqual([1, 2, 3, 4]);
    expect(rotate([1, 2, 3, 4], 6)).toEqual([3, 4, 1, 2]);
  });
});

describe('createInscriptionReconciler: disabled store', () => {
  test('no store configured → 503 inscriptions_unavailable, never throws', async () => {
    const reconciler = createInscriptionReconciler({
      store: undefined,
      provider: { getTransactionStatus: async () => ({ confirmed: false }) },
      broadcastIdempotent: async () => null,
      unreadableRecords: () => null,
      money: silentMoney,
    });
    const res = await reconciler.reconcileUser('sub-1');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('inscriptions_unavailable');
  });

  test('sweepInscriptions is a no-op without a store', async () => {
    const reconciler = createInscriptionReconciler({
      store: undefined,
      provider: { getTransactionStatus: async () => ({ confirmed: false }) },
      broadcastIdempotent: async () => null,
      unreadableRecords: () => null,
      money: silentMoney,
    });
    expect(await reconciler.sweepInscriptions()).toEqual({ processed: 0, unreadable: [] });
  });
});

describe('createInscriptionReconciler: status transitions', () => {
  test('a live pair stuck at commit_broadcast completes its reveal once the commit confirms', async () => {
    const commit = '1'.repeat(64);
    const { store, reconciler, broadcastCalls } = harness({
      txStatus: (txid) => (txid === commit ? { confirmed: true } : { confirmed: false }),
    });
    store.create('sub-1', rec({ commitTxId: commit, status: 'commit_broadcast' }));

    const { inscriptions } = await listOf(reconciler, 'sub-1');
    expect(inscriptions[0].status).toBe('reveal_broadcast');
    expect(broadcastCalls).toEqual(['02bb']); // only the reveal, not a re-push of the commit
  });

  test('a confirmed reveal below the recovery horizon stays confirmed, not retired', async () => {
    const commit = '2'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: () => ({ confirmed: true, confirmations: 2 }),
      recoveryConfirmations: 6,
    });
    store.create('sub-1', rec({ commitTxId: commit, status: 'reveal_broadcast' }));

    const { inscriptions } = await listOf(reconciler, 'sub-1');
    expect(inscriptions[0].status).toBe('confirmed');
    expect(store.get('sub-1', commit)!.retired).toBeUndefined();
  });

  test('a reveal reaching the recovery horizon is retired — recovery artifacts dropped', async () => {
    const commit = '3'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: () => ({ confirmed: true, confirmations: 6 }),
      recoveryConfirmations: 6,
    });
    store.create('sub-1', rec({ commitTxId: commit, status: 'reveal_broadcast' }));

    await listOf(reconciler, 'sub-1');
    const stored = store.get('sub-1', commit)!;
    expect(stored.status).toBe('confirmed');
    expect(stored.retired).toBe(true);
    expect(stored.revealTxHex).toBeUndefined(); // retiring drops the hex
  });

  test('a superseded pair whose commit confirmed is reinstated and its rival retired', async () => {
    const winner = '4'.repeat(64);
    const rival = '5'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: (txid) => ({ confirmed: txid === winner }),
    });
    // Same funding outpoint: rival is the live one, winner is superseded.
    store.create('sub-1', rec({ commitTxId: rival, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.create('sub-1', rec({ commitTxId: winner, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.supersede('sub-1', winner);

    const { inscriptions } = await listOf(reconciler, 'sub-1');
    const a = inscriptions.find((r) => r.commitTxId === winner)!;
    const b = inscriptions.find((r) => r.commitTxId === rival)!;
    expect(a.superseded).toBeUndefined();
    expect(b.superseded).toBe(true);
  });

  test('an unconfirmed stuck reveal is re-pushed only after the rebroadcast window elapses', async () => {
    const commit = '6'.repeat(64);
    let clock = 0;
    const { store, reconciler, broadcastCalls } = harness({
      txStatus: () => ({ confirmed: false }),
      now: () => clock,
      revealRebroadcastAfterMs: 1000,
    });
    store.create(
      'sub-1',
      rec({ commitTxId: commit, status: 'reveal_broadcast', updatedAt: new Date(0).toISOString() })
    );

    clock = 500; // inside the window — no re-push yet
    await listOf(reconciler, 'sub-1');
    expect(broadcastCalls).toEqual([]);

    clock = 1500; // past the window — re-push the retained commit, then the reveal
    await listOf(reconciler, 'sub-1');
    expect(broadcastCalls).toEqual(['02aa', '02bb']);
  });
});

describe('createInscriptionReconciler: cursor rotation and budget', () => {
  test('a superseded backlog larger than the lookup budget is fully covered across polls', async () => {
    const winner = 'a'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: (txid) => ({ confirmed: txid === winner }),
    });
    // OLDEST record is the winner; 6 newer superseded pairs on other outpoints
    // fill the rest of the per-poll budget (5).
    store.create('sub-1', rec({ commitTxId: winner, status: 'signed' }));
    store.supersede('sub-1', winner);
    for (let i = 0; i < 6; i++) {
      const id = `b${i}`.repeat(16);
      store.create('sub-1', rec({ commitTxId: id, status: 'signed', fundingOutpoints: [`${id}:0`] }));
      store.supersede('sub-1', id);
    }

    // Poll 1: budget spent on the 5 newest — winner not yet reached.
    let { inscriptions } = await listOf(reconciler, 'sub-1');
    expect(inscriptions.find((r) => r.commitTxId === winner)!.superseded).toBe(true);

    // Poll 2: the cursor advanced, so this poll starts where poll 1 stopped
    // and reaches the winner.
    ({ inscriptions } = await listOf(reconciler, 'sub-1'));
    expect(inscriptions.find((r) => r.commitTxId === winner)!.superseded).toBeUndefined();
  });

  test('cursors are per user — an interleaved poll from another user cannot re-starve the first', async () => {
    const winner = 'c'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: (txid) => ({ confirmed: txid === winner }),
    });
    store.create('sub-1', rec({ commitTxId: winner, status: 'signed' }));
    store.supersede('sub-1', winner);
    for (let i = 0; i < 6; i++) {
      const id = `d${i}`.repeat(16);
      store.create('sub-1', rec({ commitTxId: id, status: 'signed', fundingOutpoints: [`${id}:0`] }));
      store.supersede('sub-1', id);
    }
    for (let i = 0; i < 2; i++) {
      const id = `e${i}`.repeat(16);
      store.create('sub-2', rec({ commitTxId: id, status: 'signed', fundingOutpoints: [`${id}:0`] }));
      store.supersede('sub-2', id);
    }

    let rows = (await listOf(reconciler, 'sub-1')).inscriptions;
    expect(rows.find((r) => r.commitTxId === winner)!.superseded).toBe(true);
    await listOf(reconciler, 'sub-2'); // a different user's poll must not touch sub-1's cursor

    rows = (await listOf(reconciler, 'sub-1')).inscriptions; // sub-1 again, its own cursor picks up where it left off
    expect(rows.find((r) => r.commitTxId === winner)!.superseded).toBeUndefined();
  });

  test('a nonempty stuck/confirm category reserves a read, capping the superseded budget', async () => {
    // 5 superseded candidates (would exactly fill the whole budget) plus one
    // liveStuck record. Only 4 superseded reads happen (5 - 1 reserved).
    const { store, reconciler } = harness({ txStatus: () => ({ confirmed: true }) });
    for (let i = 0; i < 5; i++) {
      const id = `f${i}`.repeat(16);
      store.create('sub-1', rec({ commitTxId: id, status: 'signed', fundingOutpoints: [`${id}:0`] }));
      store.supersede('sub-1', id);
    }
    const stuckId = 'ff'.repeat(32);
    store.create('sub-1', rec({ commitTxId: stuckId, status: 'commit_broadcast', fundingOutpoints: [`${stuckId}:0`] }));

    const { inscriptions } = await listOf(reconciler, 'sub-1');
    const stillSuperseded = inscriptions.filter((r) => r.superseded).length;
    // One of the 5 superseded candidates was NOT reached this poll (budget
    // reserved a read for the nonempty liveStuck category).
    expect(stillSuperseded).toBe(1);
    expect(inscriptions.find((r) => r.commitTxId === stuckId)!.status).toBe('reveal_broadcast');
  });
});

// sweepStale(0) only counts records CREATED at or before the fake clock's
// "now" — the harness default (now: () => 0) predates every fixture's 2026
// createdAt, so these tests advance the clock to right after creation.
const SWEEP_NOW = Date.parse('2026-08-01T00:00:00.000Z');

describe('createInscriptionReconciler: sweepInscriptions', () => {
  test('sweeps stale records across users and advances the sweep cursor', async () => {
    const { store, reconciler } = harness({
      txStatus: () => ({ confirmed: true, confirmations: 6 }),
      now: () => SWEEP_NOW,
    });
    store.create('sub-1', rec({ commitTxId: '7'.repeat(64), status: 'reveal_broadcast' }));
    store.create('sub-2', rec({ commitTxId: '8'.repeat(64), status: 'reveal_broadcast' }));

    const result = await reconciler.sweepInscriptions();
    expect(result.processed).toBe(2);
    expect(result.unreadable).toEqual([]);
    expect(store.get('sub-1', '7'.repeat(64))!.retired).toBe(true);
    expect(store.get('sub-2', '8'.repeat(64))!.retired).toBe(true);
  });

  test('a sweep already running is a no-op rather than a concurrent second pass', async () => {
    let resolveStatus!: (v: { confirmed: boolean }) => void;
    const gate = new Promise<{ confirmed: boolean }>((resolve) => {
      resolveStatus = resolve;
    });
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'recon-')) });
    store.create('sub-1', rec({ commitTxId: '9'.repeat(64), status: 'reveal_broadcast' }));
    const reconciler = createInscriptionReconciler({
      store,
      provider: { getTransactionStatus: async () => gate },
      broadcastIdempotent: async () => null,
      unreadableRecords: () => null,
      money: silentMoney,
      now: () => SWEEP_NOW,
    });

    const first = reconciler.sweepInscriptions();
    const second = await reconciler.sweepInscriptions(); // fires while `first` is still awaiting the gate
    expect(second).toEqual({ processed: 0, unreadable: [] });

    resolveStatus({ confirmed: false });
    const firstResult = await first;
    expect(firstResult.processed).toBe(1);
  });
});
