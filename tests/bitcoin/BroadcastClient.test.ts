import { BroadcastClient } from '../../src/bitcoin/BroadcastClient';
import { expect } from '@jest/globals';

// Ensure Jest types are available
declare const expect: any;

describe('BroadcastClient', () => {
  test('broadcastIdempotent deduplicates by key', async () => {
    const broadcaster = jest.fn(async (hex: string) => 'txid-1');
    const status = jest.fn(async (_: string) => ({ confirmed: true, confirmations: 3 }));
    const bc = new BroadcastClient(broadcaster, status);
    const fn = () => bc.broadcastIdempotent('k', async () => broadcaster('hex'));
    const [a, b] = await Promise.all([fn(), fn()]);
    expect(a).toBe('txid-1');
    expect(b).toBe('txid-1');
    expect(broadcaster).toHaveBeenCalledTimes(1);
  });

  test('broadcastAndConfirm returns immediately when confirmed', async () => {
    const broadcaster = jest.fn(async (_: string) => 'txid-2');
    const status = jest.fn(async (_: string) => ({ confirmed: true, confirmations: 2 }));
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 1 });
    expect(res).toEqual({ txid: 'txid-2', confirmations: 2 });
  });

  test('broadcastAndConfirm polls until maxAttempts and returns last confirmations', async () => {
    const broadcaster = jest.fn(async (_: string) => 'txid-3');
    let calls = 0;
    const status = jest.fn(async (_: string) => {
      calls++;
      return { confirmed: false, confirmations: calls - 1 } as any;
    });
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 3 });
    expect(res).toEqual({ txid: 'txid-3', confirmations: expect.any(Number) });
  });

  test('broadcastAndConfirm returns 0 confirmations when provider omits confirmations', async () => {
    const broadcaster = jest.fn(async (_: string) => 'txid-4');
    const status = jest.fn(async (_: string) => ({ confirmed: false }));
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 2 });
    expect(res).toEqual({ txid: 'txid-4', confirmations: 0 });
  });

  test('broadcastAndConfirm uses defaults when options not provided', async () => {
    const broadcaster = jest.fn(async (_: string) => 'txid-5');
    const status = jest.fn(async (_: string) => ({ confirmed: true, confirmations: undefined as any }));
    const bc = new BroadcastClient(broadcaster, status);
    const res = await bc.broadcastAndConfirm('hex');
    expect(res).toEqual({ txid: 'txid-5', confirmations: 1 });
  });
});

