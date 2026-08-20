/**
 * U15 / R27 — what a stranger is told BEFORE they send mainnet BTC.
 *
 * The deposit screen is the last surface someone reads before an irreversible
 * transfer to an address they cannot withdraw from. Two things have to hold:
 * the disclosure must be there in every state (not only on a pristine first
 * visit), and no line on it may assert a custody STATUS — the previous copy
 * said "You own the keys, the change, and the inscribed sat — nothing is
 * custodied", which is a legal characterisation of a contested arrangement
 * printed directly above the address the money goes to.
 */
import { describe, test, expect } from 'bun:test';
import { demo } from '../content';
import {
  depositDisclosure,
  depositReadiness,
  depositShortfallMessage,
  depositErrorMessage,
  depositErrorBadge,
} from './Demo';

const utxo = (value: number) => ({ txid: 'a'.repeat(64), vout: 0, value, scriptPubKey: '0014' + '11'.repeat(20) });

describe('the pre-deposit disclosure (R27)', () => {
  test('states what the deposit is for, where the address came from, and what an unspent balance does', () => {
    const lines = depositDisclosure();
    expect(lines).toContain(demo.deposit.purpose);
    expect(lines).toContain(demo.deposit.addressOrigin);
    expect(lines).toContain(demo.deposit.unspentBalance);
    expect(lines).toContain(demo.deposit.nonRefundable);
    // R31's "where a stuck state will appear" stays part of the same block.
    expect(lines).toContain(demo.deposit.ifSomethingGoesWrong);
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
  });

  test('the unspent-balance line names the absence of a withdrawal path, without softening it', () => {
    const line = demo.deposit.unspentBalance;
    expect(/no withdraw|no refund|there is no withdraw/i.test(line)).toBe(true);
    // It must not promise a way out that does not exist.
    expect(/we (?:can|will) (?:send|return|refund) it back/i.test(line)).toBe(false);
    // And it must say the reachability is conditional on this service running.
    expect(/running|while this service/i.test(line)).toBe(true);
  });

  /**
   * "Rendered before an address is shown": the disclosure takes no arguments
   * and depends on nothing the server has yet to say, so it is on screen in
   * the address-pending state, on a top-up, and on a return visit where the
   * address was already issued — not only the first time.
   */
  test('does not depend on the address, the balance, or the visit being the first', () => {
    const first = depositDisclosure();
    const returning = depositDisclosure();
    expect(returning).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    expect(depositDisclosure.length).toBe(0); // no arguments = no state can suppress it
  });

  test('the address-origin line claims trust-on-first-use, not verification', () => {
    const line = demo.deposit.addressOrigin;
    // The server binds whatever address the client first presents and never
    // re-checks it against Turnkey, so the copy must not claim it did.
    expect(/verified|we check(?:ed)? (?:it|the address) (?:against|with) turnkey/i.test(line)).toBe(false);
    expect(/derived/i.test(line)).toBe(true);
    expect(/first address|first time|bound/i.test(line)).toBe(true);
  });
});

describe('no deposit string asserts a custody status', () => {
  const CUSTODY_CLAIMS = [
    /custod/i,
    /you own (?:the|your) (?:keys|change|funds|coins|sat)/i,
    /nothing is (?:custodied|held|kept)/i,
    /we (?:never|don.t) (?:hold|touch) your (?:funds|btc|bitcoin|money)/i,
  ];

  test('every published demo.deposit line is mechanics, not legal characterisation', () => {
    for (const [key, value] of Object.entries(demo.deposit)) {
      if (typeof value !== 'string') continue;
      for (const claim of CUSTODY_CLAIMS) {
        expect({ key, matched: claim.test(value) }).toEqual({ key, matched: false });
      }
    }
  });

  test('the rewritten fee line describes irreversibility instead of ownership', () => {
    expect(demo.deposit.nonRefundable).toMatch(/network fee/i);
    expect(demo.deposit.nonRefundable).toMatch(/revers|undo|refund/i);
  });

  test('the send line no longer claims a single payment is required', () => {
    // Multi-payment funding is the whole of R26; copy demanding one payment
    // would send creators back into the state the unit removes.
    expect(/in a single payment/i.test(demo.deposit.sendSuffix)).toBe(false);
    expect(/one payment or several|several/i.test(demo.deposit.sendSuffix)).toBe(true);
  });
});

describe('what the creator is told about their balance', () => {
  test('readiness reads the SUM, so two smaller deposits show as ready', () => {
    const info = {
      address: 'bc1qexample',
      confirmedUtxos: [utxo(6_000), utxo(6_000)],
      unconfirmedSats: 0,
      estimatedCostSats: 10_000,
      ordinalCheck: 'ok' as const,
    };
    expect(depositReadiness(info)).toBe('ready');
    expect(depositReadiness({ ...info, estimatedCostSats: 20_000 })).toBe('detected');
    expect(depositReadiness({ ...info, confirmedUtxos: [] })).toBe('waiting');
    // Unconfirmed money is money that has arrived, even if it cannot be spent.
    expect(depositReadiness({ ...info, confirmedUtxos: [], unconfirmedSats: 5_000 })).toBe('detected');
    expect(depositReadiness(null)).toBe('waiting');
  });

  test('an unclassifiable set reads as unspendable, never as ready', () => {
    const info = {
      address: 'bc1qexample',
      confirmedUtxos: [],
      confirmedSats: 40_000,
      unconfirmedSats: 0,
      estimatedCostSats: 10_000,
      ordinalCheck: 'unavailable' as const,
    };
    expect(depositReadiness(info)).toBe('unspendable');
    expect(typeof demo.deposit.ordinalCheckUnavailable).toBe('string');
    expect(demo.deposit.ordinalCheckUnavailable.length).toBeGreaterThan(0);
  });

  test('a shortfall names the amount rather than saying "deposit more"', () => {
    const msg = depositShortfallMessage(4_000, 6_000);
    expect(msg).toContain('4,000');
    expect(msg).toContain('6,000');
    expect(msg).toContain(demo.deposit.shortfallSuffix);
    // Nothing deposited yet is a different sentence, not a 0-sat shortfall.
    expect(depositShortfallMessage(0, 10_000)).toBe(demo.deposit.needed);
  });

  test('an unconfirmable binding is its own disclosed state, with no address', () => {
    expect(depositErrorMessage({ error: 'deposit_binding_unreadable' })).toBe(demo.deposit.bindingUnreadable);
    expect(depositErrorBadge({ error: 'deposit_binding_unreadable' })).toBe(demo.deposit.bindingBadge);
    expect(/send (?:at least|btc)/i.test(demo.deposit.bindingUnreadable)).toBe(false);
  });
});
