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

  // #777 — `settled` must track `retired` alone, matching the resubmission
  // path's `settled: rec.retired === true`, not the raw confirmations depth.
  // `reconcileRecords` spends a shared per-poll lookup budget rotated across
  // categories, so a `confirmed` record whose on-disk `confirmations` already
  // meets the recovery threshold can have its own `retire()` turn deferred
  // to a later poll — no reorg or `supersede()` required to reach that state.
  test('settled tracks retired, not the raw confirmations depth: a confirmed record the shared lookup budget has not reached this poll is not reported settled', async () => {
    const target = 'e'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: () => ({ confirmed: false }),
      recoveryConfirmations: 6,
      now: () => Date.parse('2026-08-01T00:00:30.000Z'),
    });
    // Four `commit_broadcast` decoys exhaust the shared per-poll lookup
    // budget's `stuck` share before the `confirm` category is reached.
    for (let i = 0; i < 4; i++) {
      const id = `s${i}`.padEnd(64, '0');
      store.create('sub-1', rec({
        commitTxId: id, status: 'commit_broadcast',
        createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      }));
    }
    // Target: already confirmed at/above the recovery threshold, but never
    // retired — plausible leftover state, no reorg/supersede needed.
    store.create('sub-1', rec({ commitTxId: target, status: 'signed', createdAt: '2026-08-01T00:00:10.000Z' }));
    store.setStatus('sub-1', target, 'confirmed', { confirmations: 10, blockHeight: 100, blockHash: 'f'.repeat(64) });
    // A newer `reveal_broadcast` record consumes the single reserved
    // `confirm`-category lookup this poll, so `target`'s own turn is never
    // reached.
    const decoy = 'd'.repeat(64);
    store.create('sub-1', rec({ commitTxId: decoy, status: 'reveal_broadcast', createdAt: '2026-08-01T00:00:20.000Z' }));

    const res = await reconciler.reconcileUser('sub-1');
    const { inscriptions } = (await res.json()) as {
      inscriptions: Array<{ commitTxId: string; settled?: boolean }>;
    };
    const targetEntry = inscriptions.find((r) => r.commitTxId === target)!;
    expect(targetEntry.settled).toBe(false);
    expect(store.get('sub-1', target)!.retired).toBeUndefined();
    expect(store.get('sub-1', target)!.revealTxHex).toBeDefined();

    // Once `retire()` actually runs for this record, `settled` agrees —
    // matching `bitcoin.ts`'s resubmission path for the exact same record.
    store.retire('sub-1', target);
    const after = await reconciler.reconcileUser('sub-1');
    const afterBody = (await after.json()) as { inscriptions: Array<{ commitTxId: string; settled?: boolean }> };
    expect(afterBody.inscriptions.find((r) => r.commitTxId === target)!.settled).toBe(true);
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
    // The ordinary, uncontended reclaim path completes the reveal too (#758).
    expect(a.status).toBe('reveal_broadcast');
  });

  // #758 — the OTHER await in this pass, before the reclaim: a concurrent
  // pass can retire (or reinstate) the exact record this pass is about to
  // reclaim while the commit-status lookup itself is still in flight. The
  // pre-reclaim re-check must see that and skip, rather than reclaiming an
  // outpoint out from under a state a concurrent pass already settled.
  test('a concurrent retirement during the status lookup prevents reclaiming an already-settled record', async () => {
    const winner = 'aa'.repeat(32);
    const rival = 'bb'.repeat(32);
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'recon-')) });
    store.create('sub-1', rec({ commitTxId: rival, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.create('sub-1', rec({ commitTxId: winner, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.supersede('sub-1', winner);

    const broadcastCalls: string[] = [];
    const reconciler = createInscriptionReconciler({
      store,
      provider: {
        getTransactionStatus: async (txid) => {
          if (txid === winner) {
            // Simulate a concurrent pass retiring this exact record (e.g. it
            // was reclaimed and settled via a different path) while THIS
            // pass's own commit-status lookup for it is still in flight.
            store.retire('sub-1', winner);
            return { confirmed: true };
          }
          return { confirmed: false };
        },
      },
      broadcastIdempotent: async (txHex) => {
        broadcastCalls.push(txHex ?? '');
        return null;
      },
      unreadableRecords: () => null,
      money: silentMoney,
      now: () => 0,
    });

    await reconciler.reconcileUser('sub-1');

    // The concurrent retirement stands: this pass must not reclaim the
    // outpoint (which would resurrect a retired record's hex and touch the
    // rival) on top of a state a concurrent pass already settled.
    expect(store.get('sub-1', winner)!.retired).toBe(true);
    expect(store.get('sub-1', rival)!.superseded).toBeUndefined();
    expect(broadcastCalls).toEqual([]);
  });

  // #758 — the `supersededPending` reclaim used a bare `setStatus` after TWO
  // awaits (the status lookup, then the reveal broadcast), so a concurrent
  // pass that transitioned the same record while either was in flight got
  // silently clobbered by this pass's own stale decision. These regressions
  // pin the guarded write that replaced it, mirroring the #677 guards already
  // covering `liveStuck`/`liveUnconfirmed` below.

  test('a reclaimed pair whose reveal broadcast fails lands at commit_broadcast, not reveal_broadcast', async () => {
    const winner = 'ee'.repeat(32);
    const rival = 'ff'.repeat(32);
    const { store, reconciler } = harness({
      txStatus: (txid) => ({ confirmed: txid === winner }),
      broadcastFails: true,
    });
    store.create('sub-1', rec({ commitTxId: rival, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.create('sub-1', rec({ commitTxId: winner, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.supersede('sub-1', winner);

    const { inscriptions } = await listOf(reconciler, 'sub-1');
    expect(inscriptions.find((r) => r.commitTxId === winner)!.status).toBe('commit_broadcast');
    // The reclaim itself (rival retirement, winner reinstated) still applies
    // even though the reveal broadcast failed.
    expect(store.get('sub-1', winner)!.superseded).toBeUndefined();
    expect(store.get('sub-1', rival)!.superseded).toBe(true);
  });

  test('a concurrent confirmation during the reclaim\'s reveal broadcast is not clobbered by this pass\'s own stale write', async () => {
    const winner = 'aa'.repeat(32);
    const rival = 'bb'.repeat(32);
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'recon-')) });
    store.create('sub-1', rec({ commitTxId: rival, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.create('sub-1', rec({ commitTxId: winner, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.supersede('sub-1', winner);

    const broadcastIdempotent = async (txHex: string | undefined): Promise<string | null> => {
      if (!txHex) return 'no recovery artifact for this record';
      if (txHex === '02bb') {
        // Simulate an overlapping poll (or the background sweep) confirming
        // this exact record while THIS pass's own reveal broadcast for it is
        // still in flight.
        store.setStatus('sub-1', winner, 'confirmed', {
          confirmations: 1, blockHeight: 100, blockHash: 'c'.repeat(64),
        });
      }
      return null;
    };
    const reconciler = createInscriptionReconciler({
      store,
      provider: { getTransactionStatus: async (txid) => ({ confirmed: txid === winner }) },
      broadcastIdempotent,
      unreadableRecords: () => null,
      money: silentMoney,
      now: () => 0,
    });

    await reconciler.reconcileUser('sub-1');

    const stored = store.get('sub-1', winner)!;
    // The concurrent confirmation must stand: this pass's own "reveal
    // broadcast succeeded" decision, made before it knew about the
    // confirmation, must not overwrite it.
    expect(stored.status).toBe('confirmed');
    expect(stored.confirmations).toBe(1);
    // The reclaim itself (rival retirement, winner reinstated) still applies.
    expect(stored.superseded).toBeUndefined();
    expect(store.get('sub-1', rival)!.superseded).toBe(true);
  });

  test('a concurrent retirement during the reclaim\'s reveal broadcast is not clobbered by this pass\'s own stale write', async () => {
    const winner = 'cc'.repeat(32);
    const rival = 'dd'.repeat(32);
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'recon-')) });
    store.create('sub-1', rec({ commitTxId: rival, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.create('sub-1', rec({ commitTxId: winner, status: 'signed', fundingOutpoints: [`${winner}:0`] }));
    store.supersede('sub-1', winner);

    const broadcastIdempotent = async (txHex: string | undefined): Promise<string | null> => {
      if (!txHex) return 'no recovery artifact for this record';
      if (txHex === '02bb') {
        // Simulate a concurrent pass retiring this exact record while THIS
        // pass's own reveal broadcast for it is still in flight.
        store.retire('sub-1', winner);
      }
      return null;
    };
    const reconciler = createInscriptionReconciler({
      store,
      provider: { getTransactionStatus: async (txid) => ({ confirmed: txid === winner }) },
      broadcastIdempotent,
      unreadableRecords: () => null,
      money: silentMoney,
      now: () => 0,
    });

    await reconciler.reconcileUser('sub-1');

    const stored = store.get('sub-1', winner)!;
    // The concurrent retirement must stand: no `reveal_broadcast` +
    // `retired: true` corruption, and its dropped hex must not be
    // resurrected by this pass's own stale decision.
    expect(stored.retired).toBe(true);
    expect(stored.status).toBe('signed');
    expect(stored.revealTxHex).toBeUndefined();
  });

  // #777 — the `supersededPending` pass only ever handled POSITIVE evidence
  // on a superseded record's own commit (reclaim once it confirms); a
  // negative read was a silent no-op (`if (!st?.confirmed) continue`), so a
  // record that reached `status: 'confirmed'` and was later superseded by a
  // rival kept reporting `confirmed`/`settled: true` forever, even after its
  // own commit stopped confirming (a deeper reorg than the one that
  // superseded it). These regressions pin the negative-evidence demotion
  // that closes that gap, mirroring the #677 guard already covering
  // `liveUnconfirmed` below, but keeping `superseded: true` since this pair
  // already lost the outpoint race.

  test("a superseded pair's stale confirmed status is demoted once its own commit stops confirming", async () => {
    const target = '6'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: () => ({ confirmed: false }),
    });
    store.create('sub-1', rec({ commitTxId: target, status: 'signed' }));
    store.setStatus('sub-1', target, 'confirmed', { confirmations: 3, blockHeight: 100, blockHash: 'a'.repeat(64) });
    store.supersede('sub-1', target);

    const { inscriptions } = await listOf(reconciler, 'sub-1');
    const entry = inscriptions.find((r) => r.commitTxId === target)!;
    expect(entry.status).toBe('reveal_broadcast');
    expect(entry.superseded).toBe(true);
    const stored = store.get('sub-1', target)!;
    expect(stored.confirmations).toBeUndefined(); // cleared on the demotion
    // Block identity stays sticky so a later reconfirmation can still be
    // compared against it.
    expect(stored.confirmedBlockHeight).toBe(100);
    expect(stored.confirmedBlockHash).toBe('a'.repeat(64));
  });

  test("a provider outage while checking a superseded confirmed pair's commit preserves its last observed state", async () => {
    const target = '7'.repeat(64);
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'recon-')) });
    store.create('sub-1', rec({ commitTxId: target, status: 'signed' }));
    store.setStatus('sub-1', target, 'confirmed', { confirmations: 4, blockHeight: 50, blockHash: 'b'.repeat(64) });
    store.supersede('sub-1', target);

    const reconciler = createInscriptionReconciler({
      store,
      provider: { getTransactionStatus: async () => { throw new Error('provider down'); } },
      broadcastIdempotent: async () => null,
      unreadableRecords: () => null,
      money: silentMoney,
      now: () => 0,
    });

    await reconciler.reconcileUser('sub-1');

    const stored = store.get('sub-1', target)!;
    expect(stored.status).toBe('confirmed'); // not demoted on a mere outage
    expect(stored.confirmations).toBe(4);
    expect(stored.superseded).toBe(true);
  });

  test("a concurrent reconfirmation landing during the status lookup is not clobbered by this pass's own stale negative read", async () => {
    const target = '8'.repeat(64);
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'recon-')) });
    store.create('sub-1', rec({ commitTxId: target, status: 'signed' }));
    store.setStatus('sub-1', target, 'confirmed', { confirmations: 2, blockHeight: 10, blockHash: 'c'.repeat(64) });
    store.supersede('sub-1', target);

    const reconciler = createInscriptionReconciler({
      store,
      provider: {
        getTransactionStatus: async () => {
          // A concurrent pass (an overlapping poll, or the background sweep)
          // writes fresher confirmation evidence while THIS pass's own
          // status lookup for the same commit is still in flight.
          store.setStatus('sub-1', target, 'confirmed', {
            confirmations: 5, blockHeight: 20, blockHash: 'd'.repeat(64),
          });
          return { confirmed: false };
        },
      },
      broadcastIdempotent: async () => null,
      unreadableRecords: () => null,
      money: silentMoney,
      now: () => 0,
    });

    await reconciler.reconcileUser('sub-1');

    const stored = store.get('sub-1', target)!;
    // The concurrent pass's fresher confirmation must stand: this pass's own
    // negative read, taken before that write landed, must not demote it.
    expect(stored.status).toBe('confirmed');
    expect(stored.confirmations).toBe(5);
    expect(stored.confirmedBlockHeight).toBe(20);
    expect(stored.superseded).toBe(true);
  });

  // #677 — the demotion decision must read a FRESH per-record snapshot, not
  // the snapshot taken once at the top of the whole reconciliation pass:
  // that snapshot can already be stale by the time a later record's turn
  // comes up, if an earlier record processed in the SAME pass concurrently
  // wrote to it (exactly what an overlapping `reconcileUser` call for the
  // same user, or the background sweep, would also do).
  test('a reorg is correctly demoted even when an earlier record in the same pass concurrently confirmed it', async () => {
    const target = 'a'.repeat(64);
    const trigger = 'b'.repeat(64);
    const targetReveal = `${target.slice(0, 62)}r0`;
    const triggerReveal = `${trigger.slice(0, 62)}r0`;
    const { store, reconciler } = harness({
      txStatus: (txid) => {
        if (txid === triggerReveal) {
          // While THIS pass's own read for `trigger` is "in flight", a
          // concurrent pass confirms `target` — before this pass has even
          // reached `target`'s own turn in the loop.
          store.setStatus('sub-1', target, 'confirmed', {
            confirmations: 1, blockHeight: 100, blockHash: 'a'.repeat(64),
          });
          return { confirmed: true, confirmations: 1 };
        }
        if (txid === targetReveal) {
          // This pass's OWN fresh evidence for `target`: the block it was
          // just marked confirmed in (by the concurrent write above) has
          // since been reorged out.
          return { confirmed: false };
        }
        return { confirmed: false };
      },
    });
    // `trigger` created AFTER `target` so it sorts first (newest-first) and
    // is processed before `target` within this one pass.
    store.create('sub-1', rec({ commitTxId: target, status: 'reveal_broadcast' }));
    store.create('sub-1', rec({ commitTxId: trigger, status: 'reveal_broadcast' }));

    const { inscriptions } = await listOf(reconciler, 'sub-1');

    // `target` must be DEMOTED — not left reporting the `confirmed` status a
    // concurrent write produced mid-pass, now that this pass's own reorg
    // evidence is in hand. Reading the stale top-of-pass snapshot instead of
    // a fresh per-record read would silently skip this demotion.
    expect(inscriptions.find((r) => r.commitTxId === target)!.status).toBe('reveal_broadcast');
    expect(store.get('sub-1', target)!.status).toBe('reveal_broadcast');
  });

  // #677 follow-up (Greptile P1: "Retirement Uses Stale State") — reaching
  // the recovery horizon must re-verify the record's CURRENT on-disk state
  // immediately before retiring, not just trust that "no status write was
  // needed" means nothing changed. A concurrent pass can demote a record
  // (clearing confirmations, but leaving the sticky block height/hash and
  // the still-`confirmed`-looking status/retired/superseded triple
  // untouched in ways this pass's own lagging evidence read doesn't
  // distinguish) between this pass's own snapshot and its retire decision.
  test('reaching the recovery horizon does not retire a record a concurrent pass just demoted, even when this pass\'s own evidence looks unchanged', async () => {
    const commit = 'd'.repeat(64);
    const sameHash = 'a'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: () => {
        // A concurrent pass (an overlapping poll, or the background sweep)
        // demotes this record on fresher evidence (e.g. a reorg it saw)
        // while THIS pass's own read is still in flight — and, realistically
        // hitting a different or lagging indexer node, THIS pass's own read
        // below reports the exact evidence already on file, so its own
        // "did anything change" check sees no difference.
        store.setStatus('sub-1', commit, 'reveal_broadcast');
        return { confirmed: true, confirmations: 6, blockHeight: 100, blockHash: sameHash };
      },
      recoveryConfirmations: 6,
    });
    store.create('sub-1', rec({
      commitTxId: commit, status: 'confirmed',
      confirmations: 6, confirmedBlockHeight: 100, confirmedBlockHash: sameHash,
    }));

    await listOf(reconciler, 'sub-1');

    const stored = store.get('sub-1', commit)!;
    // The concurrent demotion must stand: NOT retired, and its recovery hex
    // must survive — retiring here would delete it for a record that, per
    // the concurrent pass's fresher evidence, is not actually settled
    // (exactly the #693 failure mode: reveal_broadcast + retired:true).
    expect(stored.status).toBe('reveal_broadcast');
    expect(stored.retired).not.toBe(true);
    expect(stored.revealTxHex).toBeDefined();
  });

  test('an unchanged stale confirmation cannot retire a newer below-horizon observation', async () => {
    const commit = '8'.repeat(64);
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    const { store, reconciler, broadcastCalls } = harness({
      txStatus: () => {
        store.setStatus('sub-1', commit, 'confirmed', {
          confirmations: 1, blockHeight: 101, blockHash: newHash,
        });
        return { confirmed: true, confirmations: 6, blockHeight: 100, blockHash: oldHash };
      },
    });
    store.create('sub-1', rec({
      commitTxId: commit, status: 'confirmed',
      confirmations: 6, confirmedBlockHeight: 100, confirmedBlockHash: oldHash,
    }));

    await listOf(reconciler, 'sub-1');

    const stored = store.get('sub-1', commit)!;
    expect(stored.status).toBe('confirmed');
    expect(stored.confirmations).toBe(1);
    expect(stored.confirmedBlockHash).toBe(newHash);
    expect(stored.retired).not.toBe(true);
    expect(stored.signedCommitHex).toBe('02aa');
    expect(stored.revealTxHex).toBe('02bb');
    expect(broadcastCalls).toEqual([]);
  });

  test('a stale negative lookup cannot demote newer confirmation evidence or trigger rebroadcast', async () => {
    const commit = '9'.repeat(64);
    const newHash = 'b'.repeat(64);
    const { store, reconciler, broadcastCalls } = harness({
      txStatus: () => {
        store.setStatus('sub-1', commit, 'confirmed', {
          confirmations: 2, blockHeight: 101, blockHash: newHash,
        });
        return { confirmed: false };
      },
    });
    store.create('sub-1', rec({
      commitTxId: commit, status: 'confirmed',
      confirmations: 1, confirmedBlockHeight: 100, confirmedBlockHash: 'a'.repeat(64),
    }));

    await listOf(reconciler, 'sub-1');

    const stored = store.get('sub-1', commit)!;
    expect(stored.status).toBe('confirmed');
    expect(stored.confirmations).toBe(2);
    expect(stored.confirmedBlockHash).toBe(newHash);
    expect(stored.retired).not.toBe(true);
    expect(stored.signedCommitHex).toBe('02aa');
    expect(stored.revealTxHex).toBe('02bb');
    expect(broadcastCalls).toEqual([]);
  });

  // #677 follow-up (Greptile P1: "Guard Ignores Evidence Changes") — the
  // guarded write must also protect a `confirmed` → `confirmed` transition:
  // status/retired/superseded alone stay IDENTICAL across a purely
  // evidence-only concurrent update, so a guard that checks only those three
  // would let a stale, independently-lagging pass silently overwrite a
  // concurrent pass's fresher confirmation depth / block identity.
  test('a stale confirmed-to-confirmed write cannot clobber fresher evidence written by a concurrent pass', async () => {
    const commit = 'e'.repeat(64);
    const freshHash = 'b'.repeat(64);
    const { store, reconciler } = harness({
      txStatus: () => {
        // A concurrent pass writes FRESHER confirmation evidence for this
        // exact record while this pass's own read is still in flight.
        store.setStatus('sub-1', commit, 'confirmed', {
          confirmations: 6, blockHeight: 101, blockHash: freshHash,
        });
        // This pass's own read is independently lagging: it reports OLDER
        // evidence than what the concurrent pass just wrote.
        return { confirmed: true, confirmations: 5, blockHeight: 100, blockHash: 'a'.repeat(64) };
      },
      recoveryConfirmations: 6,
    });
    store.create('sub-1', rec({
      commitTxId: commit, status: 'confirmed',
      confirmations: 4, confirmedBlockHeight: 99, confirmedBlockHash: 'c'.repeat(64),
    }));

    await listOf(reconciler, 'sub-1');

    const stored = store.get('sub-1', commit)!;
    // The concurrent pass's fresher evidence must stand — this pass's own
    // stale read must not silently overwrite it just because status stayed
    // `confirmed` on both sides.
    expect(stored.confirmations).toBe(6);
    expect(stored.confirmedBlockHeight).toBe(101);
    expect(stored.confirmedBlockHash).toBe(freshHash);
  });

  // #677 follow-up (Greptile P1, round 2: "sticky evidence vs. raw provider
  // fields") — the guarded retire's expected snapshot must reflect what
  // `applyStatus` ACTUALLY wrote, not the raw provider read. When a
  // confirming read omits block height/hash, `applyStatus`'s sticky-evidence
  // rule leaves the record's previously-established confirmedBlockHeight/
  // Hash untouched rather than clearing them — reconstructing the retire
  // guard's expectation from the raw (undefined) provider fields would then
  // mismatch the real record and permanently block retirement.
  test('a threshold-reaching confirmation is still retired when the provider read omits block height/hash', async () => {
    const commit = 'f'.repeat(64);
    const { store, reconciler } = harness({
      // Reaches the recovery horizon, but supplies no block identity at all
      // — a real, if partial, provider response shape.
      txStatus: () => ({ confirmed: true, confirmations: 6 }),
      recoveryConfirmations: 6,
    });
    // A prior poll already established sticky block identity.
    store.create('sub-1', rec({
      commitTxId: commit, status: 'confirmed',
      confirmations: 5, confirmedBlockHeight: 100, confirmedBlockHash: 'a'.repeat(64),
    }));

    await listOf(reconciler, 'sub-1');

    const stored = store.get('sub-1', commit)!;
    expect(stored.status).toBe('confirmed');
    expect(stored.retired).toBe(true);
    expect(stored.revealTxHex).toBeUndefined(); // retiring drops the hex
  });

  // #677 — the mirror-image race: a record settles (reaches the recovery
  // horizon) and is retired by a concurrent pass WHILE this pass's own
  // network read for that exact record is in flight. The guarded write must
  // refuse to write back a decision made from before that retirement, so a
  // genuinely-settled, retired record can never regress to an internally
  // inconsistent `reveal_broadcast` + `retired: true` combination (#693).
  test('a record retired by a concurrent pass during this pass\'s own await is never clobbered', async () => {
    const commit = 'c'.repeat(64);
    const { store, reconciler, broadcastCalls } = harness({
      txStatus: () => {
        // Simulate an overlapping poll (or the background sweep) retiring
        // this exact record while this pass's own reorg-evidence read for
        // it is still outstanding.
        store.retire('sub-1', commit);
        return { confirmed: false };
      },
    });
    store.create('sub-1', rec({ commitTxId: commit, status: 'confirmed', confirmations: 2 }));

    await listOf(reconciler, 'sub-1');

    const stored = store.get('sub-1', commit)!;
    // The concurrent retirement stands untouched: no reveal_broadcast +
    // retired:true corruption, and no rebroadcast of an already-retired pair.
    expect(stored.retired).toBe(true);
    expect(stored.status).toBe('confirmed');
    expect(broadcastCalls).toEqual([]);
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

test.each([1, 0, -1, NaN, Infinity, 1.5])('direct factory keeps the six-confirmation floor for %s', async recoveryConfirmations => {
  const commitTxId = 'e'.repeat(64);
  const { store, reconciler } = harness({ recoveryConfirmations,
    txStatus: () => ({ confirmed: true, confirmations: 1 }) });
  store.create('sub-1', rec({ commitTxId, status: 'reveal_broadcast' }));
  expect((await reconciler.reconcileUser('sub-1')).status).toBe(200);
  expect(store.get('sub-1', commitTxId)?.retired).not.toBe(true);
  expect(store.get('sub-1', commitTxId)?.signedCommitHex).toBe('02aa');
});
