/**
 * U4 / R28 / R31 — the creator-facing half of the indexer seam.
 *
 * When the read behind a deposit address cannot be trusted, the page must say
 * so in its own words and show no address as ready to fund; and a stuck state
 * that outlived the tab must be renderable on return, from the server's
 * persisted alert rather than from anything a poll happened to catch.
 */
import { describe, test, expect } from 'bun:test';
import { demo, yourOriginals } from '../content';
import { depositErrorMessage, depositErrorBadge } from './Demo';
import { depositAlertMessage } from '../pages/YourOriginals';

describe('indexer-unavailable copy (R28)', () => {
  test('content.ts carries both indexer states, distinct from the fee one', () => {
    expect(typeof demo.deposit.indexerUnavailable).toBe('string');
    expect(demo.deposit.indexerUnavailable.length).toBeGreaterThan(0);
    expect(typeof demo.deposit.indexerBusy).toBe('string');
    expect(demo.deposit.indexerBusy.length).toBeGreaterThan(0);
    expect(demo.deposit.indexerUnavailable).not.toBe(demo.deposit.feeUnavailable);
    expect(demo.deposit.indexerBusy).not.toBe(demo.deposit.indexerUnavailable);
  });

  test('both named server errors map onto copy — an untrusted read is disclosed, never silent', () => {
    // Before U4 this returned null: a failed UTXO read was treated as a poll
    // blip and the last (now unverifiable) quote stayed on screen.
    expect(depositErrorMessage({ error: 'utxo_lookup_failed' })).toBe(demo.deposit.indexerUnavailable);
    expect(depositErrorMessage({ error: 'indexer_rate_limited' })).toBe(demo.deposit.indexerBusy);
    expect(depositErrorMessage({ error: 'deposit_user_cap' })).toBe(demo.deposit.indexerBusy);
    expect(depositErrorMessage({ error: 'fee_estimate_unavailable' })).toBe(demo.deposit.feeUnavailable);
    // C1/F3: the unnamed default is now copy of its own, not null — see
    // deposit-error-table.test.ts. It must stay distinct from the named ones,
    // so a generic failure never borrows a specific system's name.
    expect(depositErrorMessage(null)).toBe(demo.deposit.unknownError);
    expect(depositErrorMessage({})).toBe(demo.deposit.unknownError);
  });

  test('the badge names the system that is actually down', () => {
    // Calling an indexer outage "Fee estimate unavailable" points a creator at
    // the wrong system, and which one it is decides whether they wait or act.
    expect(depositErrorBadge({ error: 'fee_estimate_unavailable' })).toBe(demo.deposit.unavailableBadge);
    expect(depositErrorBadge({ error: 'utxo_lookup_failed' })).toBe(demo.deposit.readUnavailableBadge);
    expect(depositErrorBadge({ error: 'indexer_rate_limited' })).toBe(demo.deposit.readBusyBadge);
    expect(depositErrorBadge({ error: 'deposit_user_cap' })).toBe(demo.deposit.readBusyBadge);
    expect(depositErrorBadge({})).toBe(demo.deposit.unknownBadge);
    // Every error with copy also has a badge, and vice versa.
    for (const e of ['fee_estimate_unavailable', 'utxo_lookup_failed', 'indexer_rate_limited', 'deposit_user_cap']) {
      expect(depositErrorMessage({ error: e })).not.toBeNull();
      expect(depositErrorBadge({ error: e })).not.toBeNull();
    }
  });

  test('the copy never invites a deposit while the read is untrusted', () => {
    for (const line of [demo.deposit.indexerUnavailable, demo.deposit.indexerBusy]) {
      expect(/send (?:at least|btc)/i.test(line)).toBe(false);
    }
  });
});

describe('the stuck state on return (R31)', () => {
  test('the deposit screen names, before any BTC moves, where a stuck state will appear', () => {
    const line = demo.deposit.ifSomethingGoesWrong;
    expect(typeof line).toBe('string');
    // The promise must name the surface that actually delivers it, and must
    // not imply a channel we do not have.
    expect(line).toMatch(/Your Originals/);
    expect(line).toMatch(/don.t send email/i);
  });

  test('yourOriginals carries the persisted-alert copy', () => {
    expect(typeof yourOriginals.depositAlert.heading).toBe('string');
    expect(typeof yourOriginals.depositAlert.unavailable).toBe('string');
    expect(typeof yourOriginals.depositAlert.busy).toBe('string');
    expect(typeof yourOriginals.depositAlert.heldPrefix).toBe('string');
    expect(typeof yourOriginals.depositAlert.heldSuffix).toBe('string');
  });

  test('an alert renders as copy, with the held balance when there is one', () => {
    const held = depositAlertMessage({
      kind: 'indexer_unavailable',
      address: 'bc1qexample',
      network: 'mainnet',
      heldSats: 40_000,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(held).toContain(yourOriginals.depositAlert.unavailable);
    expect(held).toContain('40,000');
    expect(held).toContain('bc1qexample');

    const empty = depositAlertMessage({
      kind: 'indexer_rate_limited',
      address: 'bc1qexample',
      network: 'mainnet',
      heldSats: 0,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(empty).toBe(yourOriginals.depositAlert.busy);

    expect(depositAlertMessage(null)).toBeNull();
    expect(depositAlertMessage(undefined)).toBeNull();
  });
});
