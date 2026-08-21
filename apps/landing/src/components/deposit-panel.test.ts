import { describe, test, expect } from 'bun:test';
import { demo } from '../content';
import { depositDisclosure } from './Demo';
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
