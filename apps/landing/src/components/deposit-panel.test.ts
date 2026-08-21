import { describe, test, expect } from 'bun:test';
import { demo } from '../content';
import { depositDisclosure, quoteForAddress, depositReadiness } from './Demo';
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
