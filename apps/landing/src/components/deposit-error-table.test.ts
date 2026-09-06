/**
 * C1 / F3 — an unmapped deposit failure must never leave a stale address and
 * quote on screen.
 *
 * `depositErrorMessage` was a closed switch with `default: return null`, and
 * `fetchDeposit` gated its stale-quote purge on that message being non-null. So
 * any response the switch did not name cleared the banner, SKIPPED
 * `setDeposit(null)`, and kept the previous snapshot rendering — up to and
 * including the green "ready to inscribe" badge — with no error anywhere. At
 * click time the creator was then told "No confirmed deposit covering the fee
 * yet — send BTC to your deposit address", which is false and asks for money.
 *
 * The reachable unmapped set was not exotic: 429 `rate_limited` (the shared IP
 * bucket), 401 `unauthorized`, 403 `address_not_bound`, 503
 * `deposit_unavailable`, and any proxy 502/504 returning HTML — where
 * `res.json().catch(() => null)` hands the mapper a null body.
 */
import { describe, test, expect } from 'bun:test';
import { demo } from '../content';
import { depositErrorCopy, depositErrorMessage, depositErrorBadge } from './Demo';

/** The default arm, read back through the mapper itself. */
const UNKNOWN_FALLBACK = () => depositErrorCopy(null);

/** Every error code the deposit route can actually answer with. */
const SERVER_CODES = [
  'fee_estimate_unavailable',
  'utxo_lookup_failed',
  'indexer_rate_limited',
  'deposit_user_cap',
  'deposit_binding_unreadable',
  'rate_limited',
  'unauthorized',
  'address_not_bound',
  'deposit_unavailable',
  'bad_address',
  'user_quota_cap',
];

describe('the default arm is a message, not silence', () => {
  test('an unrecognised code still says something — silence is what kept the stale quote up', () => {
    const copy = depositErrorCopy({ error: 'something_new_next_quarter' });
    expect(copy.message.length).toBeGreaterThan(0);
    expect(copy.badge.length).toBeGreaterThan(0);
  });

  test('a body that is not JSON at all (proxy 502/504 HTML) is an error, not a no-op', () => {
    // fetchDeposit does `res.json().catch(() => null)`, so this IS the shape.
    expect(depositErrorMessage(null)).toBe(demo.deposit.unknownError);
    expect(depositErrorBadge(null)).toBe(demo.deposit.unknownBadge);
    expect(depositErrorMessage({})).toBe(demo.deposit.unknownError);
    expect(depositErrorMessage('<html>502 Bad Gateway</html>')).toBe(demo.deposit.unknownError);
  });

  test('every code the server can answer with maps to copy AND a badge', () => {
    for (const code of SERVER_CODES) {
      const copy = depositErrorCopy({ error: code });
      expect(copy.message.length).toBeGreaterThan(0);
      expect(copy.badge.length).toBeGreaterThan(0);
    }
  });
});

describe('the codes that were reachable and unmapped', () => {
  test('rate_limited reads like its already-mapped sibling deposit_user_cap', () => {
    // The tell that the omission was accidental: deposit_user_cap WAS mapped.
    expect(depositErrorMessage({ error: 'rate_limited' })).toBe(demo.deposit.indexerBusy);
    expect(depositErrorBadge({ error: 'rate_limited' })).toBe(demo.deposit.readBusyBadge);
  });

  test('unauthorized says the sign-in ended, not that the indexer is down', () => {
    expect(depositErrorMessage({ error: 'unauthorized' })).toBe(demo.deposit.signedOut);
    expect(depositErrorBadge({ error: 'unauthorized' })).toBe(demo.deposit.signedOutBadge);
  });

  test('address_not_bound is its own state — the address on screen is not the bound one', () => {
    expect(depositErrorMessage({ error: 'address_not_bound' })).toBe(demo.deposit.addressNotBound);
  });

  test('deposit_unavailable reads as an unreadable address, not as a fee problem', () => {
    expect(depositErrorMessage({ error: 'deposit_unavailable' })).toBe(demo.deposit.indexerUnavailable);
    expect(depositErrorMessage({ error: 'deposit_unavailable' })).not.toBe(demo.deposit.feeUnavailable);
  });
});

describe('one table, one default arm', () => {
  test('message and badge come from the SAME lookup — they cannot drift apart', () => {
    for (const code of [...SERVER_CODES, 'totally_unknown']) {
      const copy = depositErrorCopy({ error: code });
      expect(depositErrorMessage({ error: code })).toBe(copy.message);
      expect(depositErrorBadge({ error: code })).toBe(copy.badge);
    }
  });

  test('a prototype key is not a deposit error — it takes the default like anything else', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(depositErrorCopy({ error: key })).toBe(UNKNOWN_FALLBACK());
    }
  });

  test('no error copy invites a deposit while we cannot confirm one', () => {
    for (const code of [...SERVER_CODES, 'totally_unknown']) {
      const { message } = depositErrorCopy({ error: code });
      expect(/send (?:at least|btc)/i.test(message)).toBe(false);
    }
  });
});
