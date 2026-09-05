/**
 * Finishing an inscription without a browser tab (#545).
 *
 * The per-user list poll already completes a stuck pair, but only while a
 * creator is looking at /me. Measured on mainnet: a commit confirmed at 07:00Z
 * and its reveal went out at 04:45Z the next day — 21.7 hours — when the
 * creator happened to reopen the page. For a stranger who closes the tab that
 * is spent money and no inscription, permanently.
 *
 * This sweep spends real users' funds with nobody present, so the rules it must
 * not break are pinned here rather than left to review.
 */
import { describe, test, expect } from 'bun:test';
import { createInscriptionCompletionSweep, type SweepProvider } from '../inscription-completion-sweep';
import type { InscriptionRecord } from '../inscriptions-store';

const REVEAL_HEX = '0200000000';

function record(over: Partial<InscriptionRecord> = {}): InscriptionRecord {
  return {
    commitTxId: 'c'.repeat(64),
    revealTxId: 'r'.repeat(64),
    inscriptionId: `${'r'.repeat(64)}i0`,
    revealTxHex: REVEAL_HEX,
    status: 'commit_broadcast',
    createdAt: '2026-09-02T07:00:00.000Z',
    updatedAt: '2026-09-02T07:00:00.000Z',
    ...over,
  } as unknown as InscriptionRecord;
}

function harness(opts: {
  pending?: Array<{ subOrgId: string; record: InscriptionRecord }>;
  unreadable?: string[];
  confirmed?: boolean | ((txid: string) => boolean);
  broadcast?: (hex: string) => Promise<string>;
  statusThrows?: boolean;
  maxPerPass?: number;
}) {
  const pushed: string[] = [];
  const statuses: Array<{ sub: string; commitTxId: string; status: string }> = [];
  const money: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const provider: SweepProvider = {
    async getTransactionStatus(txid) {
      if (opts.statusThrows) throw new Error('indexer down');
      const c = typeof opts.confirmed === 'function' ? opts.confirmed(txid) : (opts.confirmed ?? true);
      return { confirmed: c };
    },
    async broadcastTransaction(hex) {
      pushed.push(hex);
      if (opts.broadcast) return opts.broadcast(hex);
      return 'f'.repeat(64);
    },
  };
  const sweep = createInscriptionCompletionSweep({
    store: {
      pendingRevealBroadcasts: () => ({
        pending: opts.pending ?? [{ subOrgId: 'sub-1', record: record() }],
        unreadable: opts.unreadable ?? [],
      }),
      setStatus: (sub, commitTxId, status) => {
        statuses.push({ sub, commitTxId, status });
      },
    } as never,
    provider,
    moneyLog: (event, fields) => money.push({ event, fields: (fields ?? {}) as Record<string, unknown> }),
    maxPerPass: opts.maxPerPass,
  });
  return { sweep, pushed, statuses, money };
}

describe('the inscription completion sweep', () => {
  test('a confirmed commit gets its reveal broadcast and the record advanced', async () => {
    const { sweep, pushed, statuses, money } = harness({ confirmed: true });
    const r = await sweep();

    expect(pushed).toEqual([REVEAL_HEX]);
    expect(statuses).toEqual([{ sub: 'sub-1', commitTxId: 'c'.repeat(64), status: 'reveal_broadcast' }]);
    expect(r.completed).toBe(1);
    // The server moved someone's money with nobody watching: it must be on the log.
    expect(money.map((m) => m.event)).toContain('inscription_sweep_completed');
  });

  test('an UNCONFIRMED commit is left alone — the reveal cannot spend it yet', async () => {
    const { sweep, pushed, statuses } = harness({ confirmed: false });
    const r = await sweep();

    expect(pushed).toEqual([]);
    expect(statuses).toEqual([]);
    expect(r.waiting).toBe(1);
    expect(r.completed).toBe(0);
  });

  test('the deliberate skip of an unconfirmed commit is on the money log, per record', async () => {
    const pending = [
      { subOrgId: 'sub-a', record: record({ commitTxId: 'a'.repeat(64), revealTxId: '1'.repeat(64) }) },
      { subOrgId: 'sub-b', record: record({ commitTxId: 'b'.repeat(64), revealTxId: '2'.repeat(64) }) },
    ];
    const { sweep, money } = harness({ pending, confirmed: false });
    await sweep();

    // The pass must be reconstructable from the log alone: a record the server
    // looked at and chose not to touch is a decision, not an absence of one.
    const waiting = money.filter((m) => m.event === 'inscription_sweep_waiting');
    expect(waiting.map((m) => m.fields)).toEqual([
      { sub: 'sub-a', commitTxId: 'a'.repeat(64), revealTxId: '1'.repeat(64) },
      { sub: 'sub-b', commitTxId: 'b'.repeat(64), revealTxId: '2'.repeat(64) },
    ]);
    // Identifiers only: never the signed reveal itself.
    for (const m of waiting) expect(JSON.stringify(m.fields)).not.toContain(REVEAL_HEX);
  });

  test('an already-known transaction counts as done: the client poll may have raced us', async () => {
    const { sweep, statuses, money } = harness({
      confirmed: true,
      broadcast: async () => {
        throw new Error('Transaction already in block chain');
      },
    });
    const r = await sweep();

    // Both sides finishing the same inscription is the EXPECTED case, not an
    // error — the record must still advance, or it is swept again every hour.
    expect(r.completed).toBe(1);
    expect(r.failed).toBe(0);
    expect(statuses[0].status).toBe('reveal_broadcast');
    expect(money.map((m) => m.event)).toContain('inscription_sweep_completed');
  });

  test('a genuine broadcast refusal leaves the record where it was, and is logged', async () => {
    const { sweep, statuses, money } = harness({
      confirmed: true,
      broadcast: async () => {
        throw new Error('bad-txns-inputs-missingorspent');
      },
    });
    const r = await sweep();

    expect(r.failed).toBe(1);
    expect(r.completed).toBe(0);
    // NOT advanced: claiming reveal_broadcast for a reveal that never landed
    // would hide it from this sweep forever.
    expect(statuses).toEqual([]);
    expect(money.map((m) => m.event)).toContain('inscription_sweep_push_failed');
  });

  test('a status lookup failure pushes nothing — an unknown commit is not a confirmed one', async () => {
    const { sweep, pushed, statuses, money } = harness({ statusThrows: true });
    const r = await sweep();

    expect(pushed).toEqual([]);
    expect(statuses).toEqual([]);
    expect(r.failed).toBe(1);
    expect(money.map((m) => m.event)).toContain('inscription_sweep_lookup_failed');
  });

  test('the pass is bounded: each candidate costs a chain lookup', async () => {
    const pending = Array.from({ length: 10 }, (_, i) => ({
      subOrgId: `sub-${i}`,
      record: record({ commitTxId: String(i).padStart(64, '0') }),
    }));
    const { sweep, pushed } = harness({ pending, confirmed: true, maxPerPass: 3 });
    const r = await sweep();

    expect(r.examined).toBe(3);
    expect(pushed.length).toBe(3);
  });

  test('a backlog larger than one pass cannot starve a later confirmed commit', async () => {
    // Five records, cap of 2. The first four never confirm; only the LAST does.
    // A fixed prefix would re-examine records 0 and 1 every hour and never
    // reach it: that creator's reveal is signed, held, and never broadcast.
    const pending = Array.from({ length: 5 }, (_, i) => ({
      subOrgId: `sub-${i}`,
      record: record({ commitTxId: String(i).padStart(64, '0') }),
    }));
    const confirmedCommit = pending[4].record.commitTxId;
    const { sweep, pushed, statuses } = harness({
      pending,
      confirmed: (txid) => txid === confirmedCommit,
      maxPerPass: 2,
    });

    // ceil(5 / 2) = 3 passes is the bound: every record gets examined once.
    for (let pass = 0; pass < 3; pass++) {
      const r = await sweep();
      expect(r.examined).toBe(2);
    }

    expect(pushed).toEqual([REVEAL_HEX]);
    expect(statuses).toEqual([{ sub: 'sub-4', commitTxId: confirmedCommit, status: 'reveal_broadcast' }]);
  });

  test('an unreadable records file is reported, never swallowed', async () => {
    const { sweep, money } = harness({ pending: [], unreadable: ['sub-torn'] });
    const r = await sweep();

    // That file holds the ONLY copy of a signed reveal.
    expect(r.unreadable).toEqual(['sub-torn']);
    expect(money.map((m) => m.event)).toContain('inscription_sweep_unreadable');
  });

  test('one bad record does not stop the pass', async () => {
    const pending = [
      { subOrgId: 'sub-bad', record: record({ commitTxId: 'a'.repeat(64) }) },
      { subOrgId: 'sub-good', record: record({ commitTxId: 'b'.repeat(64) }) },
    ];
    let calls = 0;
    const { sweep, statuses } = harness({
      pending,
      confirmed: true,
      broadcast: async (hex) => {
        // The FIRST candidate is refused; the second must still be attempted.
        if (++calls === 1) throw new Error('nope');
        return hex;
      },
    });
    const r = await sweep();

    expect(r.examined).toBe(2);
    expect(r.completed).toBe(1);
    expect(statuses[0].sub).toBe('sub-good');
  });
});
