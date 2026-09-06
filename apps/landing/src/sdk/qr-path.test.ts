import { describe, test, expect } from 'bun:test';
import { qrPath } from './qr-path';
import { bitcoinPaymentUri } from './bitcoin-uri';

const URI = bitcoinPaymentUri('bc1qwx77y7n2dvcfy2aejnrxcapevmssfezc4ly4rl', 14_580);

describe('the deposit QR is a well-formed code', () => {
  test('picks a version whose module count is 4n+17, as the spec requires', () => {
    const { count } = qrPath(URI);
    expect((count - 17) % 4).toBe(0);
    expect(count).toBeGreaterThanOrEqual(21); // version 1 floor
    expect(count).toBeLessThanOrEqual(177); // version 40 ceiling
  });

  test('carries the three finder patterns a scanner locates the code by', () => {
    const { path, count } = qrPath(URI);
    const dark = (r: number, c: number) => path.includes(`M${c} ${r}h1v1h-1z`);
    // Each finder is a 7x7 ring: dark corner, and a light gap at (1,1).
    for (const [r, c] of [[0, 0], [0, count - 7], [count - 7, 0]] as const) {
      expect(dark(r, c)).toBe(true);
      expect(dark(r + 1, c + 1)).toBe(false);
      expect(dark(r + 3, c + 3)).toBe(true); // solid 3x3 centre
    }
  });

  test('is deterministic — the same URI always yields the same code', () => {
    expect(qrPath(URI)).toEqual(qrPath(URI));
  });

  test('a different amount produces a different code', () => {
    const other = bitcoinPaymentUri('bc1qwx77y7n2dvcfy2aejnrxcapevmssfezc4ly4rl', 20_000);
    expect(qrPath(other).path).not.toBe(qrPath(URI).path);
  });
});
