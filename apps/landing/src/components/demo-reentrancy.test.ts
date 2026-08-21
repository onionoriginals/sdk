/**
 * FR2 — a double-click on the Inscribe button must not broadcast twice.
 *
 * The inscribe window is multi-second, the button carried no `state === 'busy'`
 * clause in its `disabled` expression, and `run()` had no in-flight guard. Two
 * concurrent `run()` calls each fetch deposit state and select funding from the
 * same still-unspent UTXOs, so both can pick the SAME outpoints and broadcast
 * conflicting commits — and whichever settles last wins the rendered state, so
 * a failing second attempt can overwrite a successful first.
 *
 * Also the missing test for `depositBadgeLabel`, which was extracted precisely
 * so the four readiness states read as a table, then shipped without one.
 */
import { describe, test, expect } from 'bun:test';
import { demo } from '../content';
import { depositBadgeLabel, runExclusive, stepButtonDisabled } from './Demo';

describe('runExclusive — one run at a time, whichever surface asks', () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  test('a second call while the first is in flight is a no-op', async () => {
    const gate = { current: false };
    const gated = deferred();
    let runs = 0;
    const first = runExclusive(gate, async () => {
      runs++;
      await gated.promise;
    });
    // The double-click, landing mid-inscribe.
    expect(await runExclusive(gate, async () => void runs++)).toBe('skipped');
    expect(runs).toBe(1);
    gated.resolve();
    expect(await first).toBe('ran');
  });

  test('the gate reopens once the run settles, so a retry still works', async () => {
    const gate = { current: false };
    expect(await runExclusive(gate, async () => {})).toBe('ran');
    expect(gate.current).toBe(false);
    expect(await runExclusive(gate, async () => {})).toBe('ran');
  });

  test('a FAILED run reopens the gate too — a stuck gate would strand the step', async () => {
    const gate = { current: false };
    await expect(
      runExclusive(gate, async () => {
        throw new Error('broadcast failed');
      })
    ).rejects.toThrow('broadcast failed');
    expect(gate.current).toBe(false);
    expect(await runExclusive(gate, async () => {})).toBe('ran');
  });
});

describe('stepButtonDisabled — a busy step is not clickable', () => {
  const base = { index: 2 as const, titleEmpty: false, pendingRevision: false, updating: false };

  test('the inscribe button is disabled while its own run is in flight', () => {
    // This clause did not exist: `state !== 'ready' && state !== 'busy'` left
    // the money button live for the whole multi-second inscribe.
    expect(stepButtonDisabled({ ...base, state: 'busy' })).toBe(true);
  });

  test('a ready step is clickable', () => {
    expect(stepButtonDisabled({ ...base, state: 'ready' })).toBe(false);
  });

  test('a locked step is not', () => {
    expect(stepButtonDisabled({ ...base, state: 'locked' })).toBe(true);
  });

  test('create still needs a title, publish still needs nothing pending', () => {
    expect(stepButtonDisabled({ ...base, index: 0, state: 'ready', titleEmpty: true })).toBe(true);
    expect(stepButtonDisabled({ ...base, index: 0, state: 'ready', titleEmpty: false })).toBe(false);
    expect(stepButtonDisabled({ ...base, index: 1, state: 'ready', pendingRevision: true })).toBe(true);
    expect(stepButtonDisabled({ ...base, index: 1, state: 'ready', updating: true })).toBe(true);
    expect(stepButtonDisabled({ ...base, index: 1, state: 'ready' })).toBe(false);
  });

  test('every step is disabled while ANY of them is busy — one run at a time', () => {
    for (const index of [0, 1, 2]) {
      expect(stepButtonDisabled({ ...base, index, state: 'ready', anyRunning: true })).toBe(true);
    }
  });
});

describe('depositBadgeLabel — the four readiness states, as a table', () => {
  test('each readiness names its own state', () => {
    expect(depositBadgeLabel('unspendable', demo.deposit)).toBe(demo.deposit.ordinalCheckBadge);
    expect(depositBadgeLabel('ready', demo.deposit)).toBe(demo.deposit.ready);
    expect(depositBadgeLabel('detected', demo.deposit)).toBe(demo.deposit.detected);
    expect(depositBadgeLabel('waiting', demo.deposit)).toBe(demo.deposit.waiting);
  });

  test('the four labels are distinct — a badge that repeats itself signals nothing', () => {
    const labels = (['unspendable', 'ready', 'detected', 'waiting'] as const).map((r) =>
      depositBadgeLabel(r, demo.deposit)
    );
    expect(new Set(labels).size).toBe(4);
  });

  test('only "ready" invites the next step; the other three do not', () => {
    expect(/ready to inscribe/i.test(depositBadgeLabel('ready', demo.deposit))).toBe(true);
    for (const r of ['unspendable', 'detected', 'waiting'] as const) {
      expect(/ready to inscribe/i.test(depositBadgeLabel(r, demo.deposit))).toBe(false);
    }
  });
});
