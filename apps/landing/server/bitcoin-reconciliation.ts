/**
 * The Bitcoin inscription reconciliation state machine (#497).
 *
 * `createBitcoinRoutes` used to own this inline — cursors, budgets and the
 * three-pass recovery walk lived as closures with no seam a unit test could
 * reach except through the full HTTP handler. Extracted here behind a small
 * dependency-injected factory so the state machine itself (cursor rotation,
 * per-poll lookup budget, status transitions) is directly testable, while
 * `createBitcoinRoutes` keeps owning auth, rate limiting and the broadcast/
 * store primitives it injects in. Behavior is unchanged — this is the same
 * code, moved.
 */
import { json } from './router';
import { outpointsOf } from './inscriptions-store';
import type { InscriptionsStore, InscriptionRecord, StatusExpectation } from './inscriptions-store';
import type { MoneyLogger } from './money-log';

/**
 * Start a stably ordered worklist at `cursor % length`. Advancing the cursor
 * by however many items a pass consumed is what lets a bounded pass cover a
 * backlog larger than itself over successive passes (both the hourly sweep
 * and the list poll's reconciliation use this; one idiom, not several).
 */
export function rotate<T>(arr: T[], cursor: number): T[] {
  if (arr.length === 0) return arr;
  const start = cursor % arr.length;
  return [...arr.slice(start), ...arr.slice(0, start)];
}

/**
 * Make `rec` the live pair for its funding outpoint: retire the current
 * rival (its commit conflicts with rec's, so at most one can ever land) and
 * clear rec's superseded flag. Used whenever evidence shows a superseded
 * pair is actually the one on the network (confirmed commit, or a
 * successful re-broadcast of its txs).
 */
export function reclaimOutpoint(store: InscriptionsStore, sub: string, rec: InscriptionRecord): void {
  // Every outpoint this pair spends, not just the identity one: a rival that
  // overlaps on ANY input conflicts with it on the network.
  for (const rival of store.findByOutpoints(sub, outpointsOf(rec))) {
    if (rival.commitTxId !== rec.commitTxId) store.supersede(sub, rival.commitTxId);
  }
  store.reinstate(sub, rec.commitTxId);
}

/** The provider surface reconciliation reads from — status only, never signs. */
export interface ReconciliationProvider {
  getTransactionStatus(
    txid: string
  ): Promise<{ confirmed: boolean; blockHeight?: number; blockHash?: string; confirmations?: number }>;
}

export interface InscriptionReconcilerDeps {
  /** Durable per-user store. Absent means reconciliation is disabled (503). */
  store: InscriptionsStore | undefined;
  provider: ReconciliationProvider;
  /** Broadcast, treating an already-known tx as success. Injected so both the
   *  inscribe/rebroadcast handlers and this reconciler share one instance. */
  broadcastIdempotent(txHex: string | undefined): Promise<string | null>;
  /** A store read that failed because the user's file is unreadable → a named
   *  503 Response; null for any other error (the caller rethrows). */
  unreadableRecords(sub: string, e: unknown): Response | null;
  money: MoneyLogger;
  now?: () => number;
  /** Application recovery horizon, not a Bitcoin finality guarantee. Minimum/default 6. */
  recoveryConfirmations?: number;
  /** How long an unconfirmed reveal may sit before the list poll re-pushes it. Default 30 min. */
  revealRebroadcastAfterMs?: number;
}

export interface InscriptionReconciler {
  reconcileUser(sub: string): Promise<Response>;
  /** The deposit-balance-adjacent stale-inscription sweep (#545). */
  sweepInscriptions(): Promise<{ processed: number; unreadable: string[] }>;
}

/**
 * GET /api/btc/inscribe backs onto `reconcileUser`. Three bounded
 * reconciliation passes ride on it, in priority order under one shared lookup
 * budget, so EVERY stranded state converges automatically — the manual Finish
 * button is a shortcut, never the only path:
 *
 * 1. SUPERSEDED pairs whose commit turns out to have CONFIRMED on-chain
 *    (the ambiguous broadcast that landed and then WON the outpoint race)
 *    are auto-recovered: the rival is retired, the winner reinstated, and
 *    its persisted reveal broadcast.
 * 2. LIVE pairs stuck at commit_broadcast (reveal broadcast failed at some
 *    point) get their reveal completed from the persisted copy once their
 *    commit confirms.
 * 3. Reveals are checked until `recoveryConfirmations`. An earlier confirmation
 *    remains reversible: retain both transactions, demote after a reorg, and
 *    rebroadcast. Retire the artifacts only at the retention horizon. One
 *    that is STILL unconfirmed after `revealRebroadcastAfterMs` is re-pushed
 *    from the persisted pair, commit first — either or both may have left
 *    the mempool.
 */
export function createInscriptionReconciler(deps: InscriptionReconcilerDeps): InscriptionReconciler {
  const now = deps.now ?? (() => Date.now());
  const requestedConfirmations = deps.recoveryConfirmations;
  const RECOVERY_CONFIRMATIONS = typeof requestedConfirmations === 'number' && Number.isInteger(requestedConfirmations)
    ? Math.max(6, requestedConfirmations) : 6;
  const REVEAL_REBROADCAST_AFTER_MS = deps.revealRebroadcastAfterMs ?? 30 * 60_000;
  const { provider, broadcastIdempotent, unreadableRecords, money } = deps;

  // Rotating scan-start cursors for the list poll's reconciliation passes.
  // Cursors are PER USER: a shared cursor advanced by every user's
  // differently sized worklist can hit a residue that lands the same subset
  // for one user forever (e.g. user A consumes 5, an interleaved user B
  // consumes 2, A's list length is 7 — A restarts at index 0 on every poll).
  // In-process bookkeeping only, not durable state: losing it on restart
  // merely restarts the rotation.
  const reconcileCursors = new Map<string, { superseded: number; stuck: number; confirm: number }>();
  function cursorsFor(sub: string): { superseded: number; stuck: number; confirm: number } {
    let c = reconcileCursors.get(sub);
    if (!c) {
      if (reconcileCursors.size >= 10_000) reconcileCursors.clear(); // bound the map
      c = { superseded: 0, stuck: 0, confirm: 0 };
      reconcileCursors.set(sub, c);
    }
    return c;
  }

  async function reconcileUser(sub: string): Promise<Response> {
    try {
      return await reconcileRecords(sub);
    } catch (error) {
      const unreadable = unreadableRecords(sub, error);
      if (unreadable) return unreadable;
      // Provider status failures are handled separately below. A persistence
      // failure must reach both the caller and the background sweep; it must
      // never become a successful response containing stale record state.
      money('inscribe_failed', { sub, reason: 'reconciliation_store_failed' });
      return json({ error: 'inscription_reconciliation_failed', message: 'Recovery records could not be reconciled durably. Retry when storage is available.' }, 503);
    }
  }

  async function reconcileRecords(sub: string): Promise<Response> {
    if (!deps.store) return json({ error: 'inscriptions_unavailable' }, 503);
    const store = deps.store;
    // A torn file must not surface as a bare, unnamed 500: this route IS the
    // automatic reconciliation, so the user whose file cannot be read is
    // exactly the one who needs an operator to know (R3).
    let records: InscriptionRecord[];
    try {
      records = store.list(sub);
    } catch (e) {
      const unreadable = unreadableRecords(sub, e);
      if (unreadable) return unreadable;
      throw e;
    }
    // Bound the per-request provider fan-out on top of the per-user quota cap
    // above. The worklist is PRIORITIZED: superseded reconciliation goes
    // first, while reserving reads for later nonempty categories. Contested
    // pairs, stranded live commits and confirmations must all make progress.
    // Within each pass a ROTATING
    // cursor picks where the scan starts, so even a backlog larger than the
    // whole budget is fully covered across successive polls — no record can
    // sit permanently behind the budget.
    let changed = false;
    const newestFirst = [...records].reverse();
    // A superseded pair whose outpoint already carries a CONFIRMED record is
    // terminally dead — its commit double-spends a confirmed tx and can never
    // land — so it is excluded from reconciliation instead of costing a
    // pointless provider lookup on every poll for the rest of time.
    const confirmedOutpoints = new Set(
      newestFirst.filter((r) => r.status === 'confirmed' && r.retired).flatMap(outpointsOf)
    );
    // Any single spent input is enough to kill a rival commit for good.
    const isDead = (r: InscriptionRecord) => outpointsOf(r).some((o) => confirmedOutpoints.has(o));
    const cursors = cursorsFor(sub);
    // Terminally-dead superseded pairs still holding hex: retire them (drop
    // the recovery artifacts, keep the row) so they stop counting against the
    // user's pending cap and stop costing disk. Costs no provider lookup.
    for (const r of newestFirst) {
      if (r.superseded && !r.retired && r.revealTxHex && isDead(r)) {
        store.retire(sub, r.commitTxId);
        changed = true;
      }
    }
    const supersededPending = rotate(
      newestFirst.filter(
        (r) =>
          r.superseded &&
          !r.retired &&
          !!r.revealTxHex &&
          !isDead(r)
      ),
      cursors.superseded
    );
    // Live pairs stuck at commit_broadcast (their reveal broadcast failed —
    // whether in the original submission, a rebroadcast, or after a reclaim):
    // once THEIR commit confirms, the persisted reveal is completed here
    // automatically, so no state depends on the manual Finish button.
    const liveStuck = rotate(
      newestFirst.filter((r) => !r.superseded && !r.retired && (r.status === 'signed' || r.status === 'commit_broadcast') && !!r.revealTxHex),
      cursors.stuck
    );
    const liveUnconfirmed = rotate(
      newestFirst.filter((r) => !r.superseded && !r.retired && (r.status === 'reveal_broadcast' || r.status === 'confirmed')),
      cursors.confirm
    );
    // Reserve one read for each later nonempty category. Priority and each
    // category's rotating cursor remain, but an unresolved contested backlog
    // can no longer consume all five reads forever.
    const supersededLimit = 5 - Number(liveStuck.length > 0) - Number(liveUnconfirmed.length > 0);
    const stuckLimit = 5 - Number(liveUnconfirmed.length > 0);
    const readStatus = async (txid: string) => {
      try { return await provider.getTransactionStatus(txid); }
      catch { return null; } // A provider outage preserves the last observed state.
    };
    let lookups = 0;
    for (const r of supersededPending) {
      if (lookups >= supersededLimit) break;
      const current = store.get(sub, r.commitTxId);
      if (!current || !current.superseded || current.retired) continue;
      lookups++;
      cursors.superseded++;
      const st = await readStatus(r.commitTxId);
      if (!st?.confirmed) continue;
      // Reclaim and journal the attempt durably before sending the exact
      // stored reveal. A failed write stops this pass before another side effect.
      reclaimOutpoint(store, sub, r);
      store.markRebroadcast(sub, r.commitTxId);
      const revealErr = await broadcastIdempotent(r.revealTxHex);
      store.setStatus(sub, r.commitTxId, revealErr ? 'commit_broadcast' : 'reveal_broadcast');
      changed = true;
    }
    for (const r of liveStuck) {
      if (lookups >= stuckLimit) break;
      const current = store.get(sub, r.commitTxId);
      if (!current || current.superseded || current.retired) continue;
      lookups++;
      cursors.stuck++;
      const st = await readStatus(r.commitTxId);
      if (!st) continue;
      if (!st.confirmed) {
        // #677 — read the FRESH pre-await snapshot (`current`), not the
        // top-of-function one (`r`): by the time this record's turn comes
        // up, `r` can be arbitrarily stale (other records' awaits already
        // ran, or a concurrent reconcileUser call for the same user already
        // moved this exact record).
        const lastPush = Date.parse(current.rebroadcastAt ?? current.updatedAt);
        if (!current.signedCommitHex || now() - lastPush < REVEAL_REBROADCAST_AFTER_MS) continue;
      }
      store.markRebroadcast(sub, r.commitTxId);
      let atStatus = current.status;
      if (!st.confirmed) {
        if (await broadcastIdempotent(current.signedCommitHex!)) continue;
        // Guarded write: a concurrent pass (an overlapping poll, or the
        // background sweep) may have already moved this record while the
        // broadcast above was in flight. Only advance it if it is still
        // exactly where this pass last observed it; otherwise stop touching
        // it rather than clobber whatever that other pass decided (#677).
        if (!store.trySetStatus(sub, r.commitTxId, { status: atStatus, retired: false, superseded: false }, 'commit_broadcast')) continue;
        atStatus = 'commit_broadcast';
        changed = true;
      }
      const revealErr = await broadcastIdempotent(current.revealTxHex);
      if (!revealErr) {
        if (store.trySetStatus(sub, r.commitTxId, { status: atStatus, retired: false, superseded: false }, 'reveal_broadcast')) changed = true;
      }
    }
    for (const r of liveUnconfirmed) {
      if (lookups >= 5) break;
      const current = store.get(sub, r.commitTxId);
      if (!current || current.superseded || current.retired) continue;
      lookups++;
      cursors.confirm++;
      const st = await readStatus(r.revealTxId);
      if (!st) continue;
      if (st.confirmed) {
        // A reconfirmation whose block IDENTITY differs from the one last
        // observed means a reorg happened — whether or not this poll (or an
        // earlier one) ever saw the intervening unconfirmed state to demote
        // through: `confirmedBlockHash`/`confirmedBlockHeight` deliberately
        // survive that demotion (see InscriptionRecord) so this comparison
        // still catches it. Compare HASH when both sides have one — the
        // actual block identity, which catches an ordinary one-block reorg
        // that replaces the block at the SAME height with a different one,
        // something a height-only comparison cannot see. Fall back to height
        // only when a hash is unavailable on either side (an older record
        // written before this field existed, or a provider that cannot
        // supply one). Depth itself is always freshly computed from the
        // current chain view below, so this is a signal worth logging, not a
        // correctness gate.
        const reorgedBlock =
          current.confirmedBlockHash !== undefined && st.blockHash !== undefined
            ? st.blockHash !== current.confirmedBlockHash
            : current.confirmedBlockHeight !== undefined &&
              st.blockHeight !== undefined &&
              st.blockHeight !== current.confirmedBlockHeight;
        if (reorgedBlock) {
          money('inscribe_reorg_reconfirmed', {
            sub,
            commitTxId: r.commitTxId,
            revealTxId: r.revealTxId,
            previousBlockHeight: current.confirmedBlockHeight,
            blockHeight: st.blockHeight,
            ...(current.confirmedBlockHash !== undefined ? { previousBlockHash: current.confirmedBlockHash } : {}),
            ...(st.blockHash !== undefined ? { blockHash: st.blockHash } : {}),
          });
        }
        // Skip the write once depth/height/hash/status all already match:
        // this is the steady state for a record sitting well below the
        // settlement threshold that keeps being re-polled while other work
        // is pending.
        const needsWrite =
          current.status !== 'confirmed' ||
          current.confirmations !== st.confirmations ||
          current.confirmedBlockHeight !== st.blockHeight ||
          current.confirmedBlockHash !== st.blockHash;
        // Guarded write (#677/#694): only apply if the record's
        // status/retired/superseded AND its confirmation evidence are still
        // exactly where this pass last observed them. The evidence fields
        // matter here specifically: status/retired/superseded alone stay
        // IDENTICAL across a purely evidence-only concurrent update (a
        // fresher confirmation depth or reorg block identity written by
        // another pass) — checking only those three would let a stale pass
        // silently overwrite newer evidence with older evidence.
        const applied = needsWrite
          ? store.trySetStatus(
              sub, r.commitTxId,
              {
                status: current.status, retired: false, superseded: false,
                confirmations: current.confirmations,
                confirmedBlockHeight: current.confirmedBlockHeight,
                confirmedBlockHash: current.confirmedBlockHash,
              },
              'confirmed',
              { confirmations: st.confirmations, blockHeight: st.blockHeight, blockHash: st.blockHash }
            )
          : true;
        if (needsWrite && applied) changed = true;
        if (applied && (st.confirmations ?? 0) >= RECOVERY_CONFIRMATIONS) {
          // Guarded retire: re-verify against the record's CURRENT on-disk
          // state immediately before retiring, rather than trusting the
          // `applied` shortcut above at face value — a concurrent pass could
          // have demoted (or already retired) this record without touching
          // the confirmation evidence this pass compared, which would
          // otherwise let this pass delete a still-live pair's only
          // recovery artifacts on stale authority.
          //
          // After our guarded write, read back its sticky block identity;
          // omitted provider fields need not equal the stored values. With
          // no write, retain the PRE-await snapshot as the expectation:
          // rereading here would authorize retirement using evidence that
          // another pass changed while this lookup was in flight.
          // No await separates a successful write from this read/retire.
          const postWrite = needsWrite ? store.get(sub, r.commitTxId) : current;
          const retireExpected: StatusExpectation | undefined = postWrite
            ? {
                status: 'confirmed', retired: false, superseded: false,
                confirmations: postWrite.confirmations,
                confirmedBlockHeight: postWrite.confirmedBlockHeight,
                confirmedBlockHash: postWrite.confirmedBlockHash,
              }
            : undefined;
          if (retireExpected && store.tryRetire(sub, r.commitTxId, retireExpected)) changed = true;
        }
        continue;
      }
      // #677 — the demotion decision itself must read the FRESH pre-await
      // snapshot (`current`), not the top-of-function one (`r`): `r` can
      // already be stale by the time this record's turn comes up (e.g. a
      // concurrent reconcileUser call for the same user confirmed this
      // exact record while THIS pass's own provider read was in flight).
      // Reading `r.status` here let a genuinely-reorged-out record stay
      // reported `confirmed` on stale evidence instead of being demoted.
      if (current.status === 'confirmed') {
        // Guarded write: skip the demotion (and the rebroadcast it would
        // trigger) if the record no longer matches what was just observed —
        // e.g. it was retired by a concurrent pass in the meantime.
        if (store.trySetStatus(sub, r.commitTxId, {
          status: 'confirmed', retired: false, superseded: false,
          confirmations: current.confirmations,
          confirmedBlockHeight: current.confirmedBlockHeight,
          confirmedBlockHash: current.confirmedBlockHash,
        }, 'reveal_broadcast')) {
          changed = true;
          store.markRebroadcast(sub, r.commitTxId);
          if (current.signedCommitHex) await broadcastIdempotent(current.signedCommitHex);
          if (current.revealTxHex) await broadcastIdempotent(current.revealTxHex);
        }
        continue;
      }
      // Keep the manual-retry status clock unchanged; the independent durable
      // attempt timestamp throttles resubmission even after ambiguous delivery.
      const lastPush = Date.parse(current.rebroadcastAt ?? current.updatedAt);
      if (current.revealTxHex && now() - lastPush >= REVEAL_REBROADCAST_AFTER_MS) {
        store.markRebroadcast(sub, r.commitTxId);
        // Both transactions can disappear from the mempool. Replaying the
        // exact retained parent first also works when it is already known;
        // an ambiguous parent failure retains the pair for the next attempt.
        if (current.signedCommitHex && await broadcastIdempotent(current.signedCommitHex)) continue;
        await broadcastIdempotent(current.revealTxHex);
      }
    }
    if (changed) {
      try {
        records = store.list(sub);
      } catch (e) {
        const unreadable = unreadableRecords(sub, e);
        if (unreadable) return unreadable;
        throw e;
      }
    }
    const inscriptions = records.map((r) => {
      const outpoints = outpointsOf(r);
      return {
      commitTxId: r.commitTxId,
      revealTxId: r.revealTxId,
      inscriptionId: r.inscriptionId,
      // Singular stays the IDENTITY outpoint so existing clients keep working.
      fundingOutpoint: outpoints[0],
      fundingOutpoints: outpoints,
      status: r.status,
      ...(r.superseded ? { superseded: true } : {}),
      // The settlement contract (#567): a `confirmed` record is either
      // confirmed-but-unsettled (still within the recovery window, both
      // transactions retained) or settled (recovery artifacts retired once
      // `confirmations` reaches the configured threshold). Absent for every
      // other status — depth/height are current-truth-while-confirmed only.
      ...(r.status === 'confirmed'
        ? {
            confirmations: r.confirmations,
            settled: r.retired === true || (r.confirmations ?? 0) >= RECOVERY_CONFIRMATIONS,
            ...(r.confirmedBlockHeight !== undefined ? { confirmedBlockHeight: r.confirmedBlockHeight } : {}),
            ...(r.confirmedBlockHash !== undefined ? { confirmedBlockHash: r.confirmedBlockHash } : {}),
          }
        : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      };
    });
    // R31: the deposit-read outage reaches someone who already left. This
    // route is what the Your Originals page loads on every visit, so a stuck
    // state raised while nobody was looking is on screen when they come back —
    // rather than only in a 15s poll on a tab that is long closed.
    const depositAlert = store.getDepositAlert(sub);
    return json({ inscriptions, ...(depositAlert ? { depositAlert } : {}) });
  }

  let sweepRunning = false;
  let sweepCursor = 0;
  // Uses the same bounded reconciliation as an authenticated poll. No HTTP
  // token is synthesized and no signed pair is rebuilt by this background job.
  async function sweepInscriptions(): Promise<{ processed: number; unreadable: string[] }> {
    if (!deps.store || sweepRunning) return { processed: 0, unreadable: [] };
    sweepRunning = true;
    try {
      const { stale, unreadable } = deps.store.sweepStale(0);
      const subs = rotate([...new Set(stale.map((row) => row.subOrgId))].sort(), sweepCursor).slice(0, 10);
      const failures = [...unreadable];
      for (const sub of subs) {
        try { if (!(await reconcileUser(sub)).ok) failures.push(sub); }
        catch { failures.push(sub); }
      }
      sweepCursor += subs.length;
      return { processed: subs.length, unreadable: [...new Set(failures)] };
    } finally { sweepRunning = false; }
  }

  return { reconcileUser, sweepInscriptions };
}
