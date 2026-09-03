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
  store: Pick<InscriptionsStore, 'pendingRevealBroadcasts' | 'setStatus'>;
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

  return async () => {
    const result: CompletionSweepResult = {
      examined: 0,
      completed: 0,
      waiting: 0,
      failed: 0,
      unreadable: [],
    };

    const { pending, unreadable } = deps.store.pendingRevealBroadcasts();
    result.unreadable = unreadable;
    if (unreadable.length > 0) {
      deps.moneyLog('inscription_sweep_unreadable', { subs: unreadable.join(',') });
    }

    for (const { subOrgId, record } of pending) {
      if (result.examined >= max) break;
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
        result.waiting++;
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
      deps.store.setStatus(subOrgId, record.commitTxId, 'reveal_broadcast');
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
