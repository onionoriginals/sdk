import { describe, test, expect } from 'bun:test';
import { demo } from '../content';
import { depositDisclosure, quoteForAddress, depositReadiness, depositBadgeLabel } from './Demo';
import { bitcoinPaymentUri } from '../sdk/bitcoin-uri';

/**
 * The redesign moved the R27 disclosure from BETWEEN the amount and the
 * address to BELOW both. The risk in any such move is that text quietly goes
 * missing, so these assert the opposite: every original line is still on the
 * screen, and the shortened lines add to them rather than replace them.
 */
describe('the deposit redesign keeps every word of the disclosure', () => {
  const rendered = [
    demo.deposit.purposeShort,
    demo.deposit.riskSummary,
    // What the <details> renders, in order.
    demo.deposit.purpose,
    demo.deposit.addressOrigin,
    demo.deposit.unspentBalance,
    demo.deposit.nonRefundable,
    demo.deposit.ifSomethingGoesWrong,
  ];

  test('every line of the R27 contract is still rendered', () => {
    for (const line of depositDisclosure()) {
      expect(rendered).toContain(line);
    }
  });

  test('the short lines are additions, not replacements', () => {
    // If a summary were ever swapped IN for a full line, the count drops.
    expect(rendered.length).toBe(depositDisclosure().length + 2);
  });
});

describe('the two money risks do not require a click to see', () => {
  const risk = demo.deposit.riskSummary;

  test('names the absence of a withdrawal and of a refund', () => {
    expect(/no withdraw/i.test(risk)).toBe(true);
    expect(/refund/i.test(risk)).toBe(true);
  });

  test('names irreversibility, and does not exempt us from it', () => {
    expect(/can.t be reversed|cannot be reversed/i.test(risk)).toBe(true);
    expect(/us included|including us/i.test(risk)).toBe(true);
  });

  test('tells them to send the quoted amount, not a round number', () => {
    expect(/round number/i.test(risk)).toBe(true);
  });

  // The summary must not promise a way out that the long-form line denies.
  test('promises no refund path anywhere', () => {
    expect(/we (?:can|will) (?:send|return|refund) it back/i.test(risk)).toBe(false);
  });
});

describe('paying takes no transcription', () => {
  const address = 'bc1qwx77y7n2dvcfy2aejnrxcapevmssfezc4ly4rl';

  test('the wallet link carries both the address and the exact quoted amount', () => {
    const uri = bitcoinPaymentUri(address, 14_580);
    expect(uri).toBe(`bitcoin:${address}?amount=0.0001458`);
  });

  test('the QR encodes that same URI, not the bare address', () => {
    // Same helper feeds the link and the code, so they cannot drift apart.
    expect(bitcoinPaymentUri(address, 14_580)).toContain('amount=');
  });
});

describe('a quote never crosses to another address', () => {
  const A = 'bc1qwx77y7n2dvcfy2aejnrxcapevmssfezc4ly4rl';
  const B = 'bc1qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const quote = (address: string) => ({
    address,
    confirmedUtxos: [],
    confirmedSats: 50_000,
    unconfirmedSats: 0,
    estimatedCostSats: 14_580,
  });

  test('a quote for the current address is used', () => {
    expect(quoteForAddress(quote(A), A)).not.toBeNull();
  });

  /**
   * The bug: reset() on an identity change clears the engine and the asset but
   * not the quote, so the previous account's balance could be shown against
   * the new account's address — "ready to inscribe" for someone who has sent
   * nothing, and the old amount behind the new address in the wallet link.
   */
  test('a quote left over from another identity is not', () => {
    expect(quoteForAddress(quote(A), B)).toBeNull();
  });

  test('nothing is rendered before an address is known', () => {
    expect(quoteForAddress(quote(A), null)).toBeNull();
    expect(quoteForAddress(quote(A), undefined)).toBeNull();
    expect(quoteForAddress(null, A)).toBeNull();
  });

  // The readiness badge reads off the quote, so the guard has to sit upstream
  // of it — otherwise the stale balance still turns the badge green.
  test('a mismatched quote cannot drive the readiness badge', () => {
    expect(depositReadiness(quoteForAddress(quote(A), B))).toBe('waiting');
    expect(depositReadiness(quoteForAddress(quote(A), A))).not.toBe('waiting');
  });
});

describe('a confirmed deposit that does not cover the cost', () => {
  const utxo = (value: number) => ({
    txid: 'a'.repeat(64),
    vout: 0,
    value,
    scriptPubKey: '0014' + '11'.repeat(20),
  });
  const info = (confirmed: number, cost: number) => ({
    address: 'bc1qwx77y7n2dvcfy2aejnrxcapevmssfezc4ly4rl',
    confirmedUtxos: confirmed > 0 ? [utxo(confirmed)] : [],
    confirmedSats: confirmed,
    unconfirmedSats: 0,
    estimatedCostSats: cost,
  });

  /**
   * The live failure. 14,580 confirmed against an 18,599 quote reported
   * 'detected', whose copy reads "waiting for one confirmation" — so a creator
   * whose money HAD confirmed watched a poll for an event already past, and was
   * never told they were 4,019 short.
   */
  test('is not reported as waiting for a confirmation that already happened', () => {
    expect(depositReadiness(info(14_580, 18_599))).toBe('short');
    expect(depositReadiness(info(14_580, 18_599))).not.toBe('detected');
  });

  test('its badge does not promise a pending confirmation', () => {
    const label = depositBadgeLabel('short', demo.deposit);
    expect(label).not.toMatch(/waiting/i);
    expect(label).toMatch(/top-up|confirmed/i);
  });

  test('enough is still ready, and exactly enough counts', () => {
    expect(depositReadiness(info(18_599, 18_599))).toBe('ready');
    expect(depositReadiness(info(20_000, 18_599))).toBe('ready');
  });

  test('nothing confirmed yet is still waiting, not short', () => {
    expect(depositReadiness(info(0, 18_599))).toBe('waiting');
  });

  // The quote already prices the top-up's own input (server: used + 1), so the
  // displayed gap is the whole gap — a creator who sends it is not short again.
  test('the gap shown is the whole gap', () => {
    const i = info(14_580, 18_599);
    const held = i.confirmedUtxos.reduce((n, u) => n + u.value, 0);
    expect(i.estimatedCostSats - held).toBe(4_019);
    expect(depositReadiness({ ...i, confirmedUtxos: [utxo(18_599)], confirmedSats: 18_599 })).toBe('ready');
  });
});

describe('a funded deposit stops asking for money', () => {
  /**
   * The UX failure: the panel rendered "Send at least N sats" regardless of
   * readiness, so someone whose deposit already covered the cost was still
   * being told to pay, with no indication the next move was theirs.
   * depositReadiness is what the panel now switches on.
   */
  const utxo = (value: number) => ({ txid: 'a'.repeat(64), vout: 0, value, scriptPubKey: '0014' + '11'.repeat(20) });
  const info = (confirmed: number, cost: number) => ({
    address: 'bc1qwx77y7n2dvcfy2aejnrxcapevmssfezc4ly4rl',
    confirmedUtxos: [utxo(confirmed)],
    confirmedSats: confirmed,
    unconfirmedSats: 0,
    estimatedCostSats: cost,
  });

  test('leftover sats keep a later inscription funded without a new deposit', () => {
    // 19,580 held against a 14,580 cost: funded, and the surplus stays put.
    expect(depositReadiness(info(19_580, 14_580))).toBe('ready');
  });

  test('the funded and unfunded states are distinguishable by readiness alone', () => {
    expect(depositReadiness(info(19_580, 14_580))).toBe('ready');
    expect(depositReadiness(info(14_580, 18_599))).toBe('short');
  });

  test('the funded copy tells the creator to inscribe, not to send more', () => {
    expect(demo.deposit.fundedHeading).toMatch(/ready to inscribe/i);
    expect(demo.deposit.fundedBody).not.toMatch(/send/i);
  });

  test('the balance copy explains that a surplus is reusable, not stranded', () => {
    expect(demo.deposit.balanceReuse).toMatch(/next inscription/i);
  });
});
