/**
 * Finish a confirmed-commit inscription without a browser tab (#545).
 *
 * The per-user list poll already completes a pair stuck at `commit_broadcast`
 * once its commit confirms — but it only runs while a creator is looking at
 * `/me`. Measured on mainnet: a commit confirmed at 07:00Z and its reveal was
 * not broadcast until 04:45Z the next day, 21.7 hours later, when the creator
 * happened to reopen the page. Nothing was wrong with the reveal; it was signed
 * and persisted the whole time.
 *
 * For a signed-in creator with a tab open that is merely slow. For a stranger
 * who closes the tab it is spent money and no inscription, permanently, because
 * there is no email, no notification, and no other path back. The server has
 * the signed reveal, sweeps hourly, and can see the commit confirmed — it
 * simply never pushed.
 *
 * This is the server acting on a user's funds with the user absent, so every
 * push, skip and failure goes to the money log: the whole pass must be
 * reconstructable afterwards from that log alone.
 */
import { isAlreadyKnownTxError } from './bitcoin';
import type { InscriptionsStore } from './inscriptions-store';
import type { MoneyEvent, MoneyFields } from './money-log';

/** Just the slice of the provider this sweep uses. */
export interface SweepProvider {
  getTransactionStatus(txid: string): Promise<{ confirmed: boolean } | null | undefined>;
  broadcastTransaction(txHex: string): Promise<string>;
}

export interface CompletionSweepDeps {
  store: Pick<InscriptionsStore, 'pendingRevealBroadcasts' | 'trySetStatus'>;
  provider: SweepProvider;
  moneyLog: (event: MoneyEvent, fields?: MoneyFields) => void;
  /**
   * Chain lookups this pass may spend. Each candidate costs one
   * `getTransactionStatus`, which is billed indexer budget — the same
   * consideration that caps the deposit sweep.
   */
  maxPerPass?: number;
}

export interface CompletionSweepResult {
  /** Candidates considered (bounded by maxPerPass). */
  examined: number;
  /** Reveals successfully broadcast, moving the record to reveal_broadcast. */
  completed: number;
  /** Commits not yet confirmed — the reveal cannot spend them yet. */
  waiting: number;
  /** Push attempted and refused; the record stays at commit_broadcast. */
  failed: number;
  /** A concurrent reconciliation pass already moved the record while this
   *  pass's own status lookup/broadcast were in flight (#694); this pass's
   *  write was skipped rather than clobbering that pass's result. */
  raced: number;
  /** Files that could not be parsed. Their signed reveals are unreachable. */
  unreadable: string[];
}

/**
 * One pass. Returns counts for the caller to log; every individual decision is
 * already on the money log by the time this returns.
 */
export function createInscriptionCompletionSweep(
  deps: CompletionSweepDeps
): () => Promise<CompletionSweepResult> {
  const max = deps.maxPerPass ?? 25;
  // Preserve waiting order across passes even when the store membership changes.
  // New records join the tail, so they cannot displace records already waiting.
  let queue: string[] = [];

  return async () => {
    const result: CompletionSweepResult = {
      examined: 0,
      completed: 0,
      waiting: 0,
      failed: 0,
      raced: 0,
      unreadable: [],
    };

    const { pending, unreadable } = deps.store.pendingRevealBroadcasts();
    result.unreadable = unreadable;
    if (unreadable.length > 0) {
      deps.moneyLog('inscription_sweep_unreadable', { subs: unreadable.join(',') });
    }

    // Stable order first: the store walks a directory, whose order is not.
    pending.sort((a, b) =>
      (a.subOrgId + a.record.commitTxId).localeCompare(b.subOrgId + b.record.commitTxId)
    );
    const candidates = new Map(
      pending.map((candidate) => [
        JSON.stringify([candidate.subOrgId, candidate.record.commitTxId]),
        candidate,
      ])
    );
    queue = queue.filter((key) => candidates.has(key));
    const queued = new Set(queue);
    for (const key of candidates.keys()) {
      if (!queued.has(key)) queue.push(key);
    }
    const selected = queue.splice(0, max);
    queue.push(...selected);
    const pass = selected.map((key) => candidates.get(key)!);

    for (const { subOrgId, record } of pass) {
      result.examined++;

      // The reveal spends the commit's output 0, so pushing before the commit
      // confirms is a guaranteed rejection and a wasted lookup. Ask first.
      let confirmed: boolean;
      try {
        const st = await deps.provider.getTransactionStatus(record.commitTxId);
        confirmed = st?.confirmed === true;
      } catch (e) {
        // Lookup down or unsupported: leave the record exactly as stored. The
        // list poll and the manual Finish button both still cover it.
        result.failed++;
        deps.moneyLog('inscription_sweep_lookup_failed', {
          sub: subOrgId,
          commitTxId: record.commitTxId,
          reason: (e as Error)?.message ?? 'unknown',
        });
        continue;
      }

      if (!confirmed) {
        // A deliberate no-op is still a decision about someone's money.
        result.waiting++;
        deps.moneyLog('inscription_sweep_waiting', {
          sub: subOrgId,
          commitTxId: record.commitTxId,
          revealTxId: record.revealTxId,
        });
        continue;
      }

      try {
        await deps.provider.broadcastTransaction(record.revealTxHex!);
      } catch (e) {
        // An already-known transaction IS success: the client poll may have
        // pushed the same reveal moments earlier, and both sides racing to
        // finish the same inscription is the expected case, not an error.
        if (!isAlreadyKnownTxError(e)) {
          result.failed++;
          deps.moneyLog('inscription_sweep_push_failed', {
            sub: subOrgId,
            commitTxId: record.commitTxId,
            revealTxId: record.revealTxId,
            reason: (e as Error)?.message ?? 'unknown',
          });
          continue;
        }
      }

      // Only now: the reveal is on the network, by our push or someone's.
      //
      // Guarded write (#694): `record` is the snapshot taken before the
      // status lookup and broadcast above, both of which awaited real
      // network round trips. A concurrent reconciliation pass for the same
      // user (the per-user list poll, or an overlapping sweep run — this
      // sweep's own `sweepRunning` guard only prevents two sweep passes
      // overlapping each OTHER, not one overlapping a live poll) can have
      // confirmed or retired this exact record during either await. Writing
      // 'reveal_broadcast' unconditionally at that point would silently
      // regress a genuinely-confirmed record back down, or resurrect a
      // retired one — the mirror image of #677 in this background sweep.
      // Only advance the record if it is still exactly where it was found;
      // otherwise the concurrent pass's result stands.
      const applied = deps.store.trySetStatus(
        subOrgId,
        record.commitTxId,
        { status: 'commit_broadcast', retired: false, superseded: false },
        'reveal_broadcast'
      );
      if (!applied) {
        result.raced++;
        deps.moneyLog('inscription_sweep_raced', {
          sub: subOrgId,
          commitTxId: record.commitTxId,
          revealTxId: record.revealTxId,
        });
        continue;
      }
      result.completed++;
      deps.moneyLog('inscription_sweep_completed', {
        sub: subOrgId,
        commitTxId: record.commitTxId,
        revealTxId: record.revealTxId,
        inscriptionId: record.inscriptionId,
      });
    }

    return result;
  };
}
