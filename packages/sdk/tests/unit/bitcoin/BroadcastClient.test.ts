import { describe, test, expect, mock } from 'bun:test';
import { BroadcastClient } from '../../../src/bitcoin/BroadcastClient';

describe('BroadcastClient', () => {
  test('broadcastIdempotent deduplicates by key', async () => {
    const broadcaster = mock(async (hex: string) => 'txid-1');
    const status = mock(async (_: string) => ({ confirmed: true, confirmations: 3 }));
    const bc = new BroadcastClient(broadcaster, status);
    const fn = () => bc.broadcastIdempotent('k', async () => broadcaster('hex'));
    const [a, b] = await Promise.all([fn(), fn()]);
    expect(a).toBe('txid-1');
    expect(b).toBe('txid-1');
    expect(broadcaster).toHaveBeenCalledTimes(1);
  });

  test('broadcastAndConfirm returns immediately when confirmed', async () => {
    const broadcaster = mock(async (_: string) => 'txid-2');
    const status = mock(async (_: string) => ({ confirmed: true, confirmations: 2 }));
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 1 });
    expect(res).toEqual({ txid: 'txid-2', confirmations: 2 });
  });

  test('broadcastAndConfirm polls until maxAttempts and returns last confirmations', async () => {
    const broadcaster = mock(async (_: string) => 'txid-3');
    let calls = 0;
    const status = mock(async (_: string) => {
      calls++;
      return { confirmed: false, confirmations: calls - 1 } as any;
    });
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 3 });
    expect(res).toEqual({ txid: 'txid-3', confirmations: expect.any(Number) });
  });

  test('broadcastAndConfirm returns 0 confirmations when provider omits confirmations', async () => {
    const broadcaster = mock(async (_: string) => 'txid-4');
    const status = mock(async (_: string) => ({ confirmed: false }));
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 2 });
    expect(res).toEqual({ txid: 'txid-4', confirmations: 0 });
  });

  test('broadcastAndConfirm uses defaults when options not provided', async () => {
    const broadcaster = mock(async (_: string) => 'txid-5');
    const status = mock(async (_: string) => ({ confirmed: true, confirmations: undefined as any }));
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex');
    expect(res).toEqual({ txid: 'txid-5', confirmations: 1 });
  });

  test('broadcastAndConfirm never loses the txid when status polling throws (issue #271)', async () => {
    // The tx broadcast succeeds; every status poll then fails transiently.
    // The method must still resolve with the txid so the caller does NOT treat
    // the operation as failed and rebroadcast a second commit over the same
    // UTXOs (a double-spend / fund-loss race).
    const broadcaster = mock(async (_: string) => 'txid-broadcast');
    let polls = 0;
    const status = mock(async (_: string) => {
      polls++;
      throw new Error('status endpoint 500');
    });
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 3 });
    expect(res.txid).toBe('txid-broadcast');
    expect(res.confirmations).toBe(0);
    expect(polls).toBe(3); // a throwing poll counts as an unconfirmed attempt
    expect(broadcaster).toHaveBeenCalledTimes(1); // broadcast is never retried
  });

  test('broadcastAndConfirm confirms once the status endpoint recovers (issue #271)', async () => {
    const broadcaster = mock(async (_: string) => 'txid-recover');
    let polls = 0;
    const status = mock(async (_: string) => {
      polls++;
      if (polls < 2) throw new Error('transient failure');
      return { confirmed: true, confirmations: 4 };
    });
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 5 });
    expect(res).toEqual({ txid: 'txid-recover', confirmations: 4 });
  });
});

