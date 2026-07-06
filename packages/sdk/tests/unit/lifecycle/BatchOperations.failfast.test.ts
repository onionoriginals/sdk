/**
 * Item 4 (BatchOperationExecutor part): fail-fast batches must actually stop
 * and must not hand out live, still-mutating result arrays.
 *
 * Previously, concurrent fail-fast used Promise.all: the throw propagated
 * while sibling operations kept running, later chunks were prevented, but
 * (a) the BatchError.result wrapped the LIVE successful/failed arrays that
 * siblings continued to mutate after the error was thrown, and (b) sibling
 * items kept retrying (and potentially broadcasting) after the batch had
 * already failed.
 */
import { describe, test, expect } from 'bun:test';
import { BatchOperationExecutor, BatchError } from '../../../src/lifecycle/BatchOperations';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BatchOperationExecutor fail-fast', () => {
  test('BatchError.result is a stable snapshot that includes settled siblings and never mutates afterwards', async () => {
    const executor = new BatchOperationExecutor();
    const started: number[] = [];

    // Chunk 1 (maxConcurrent=3): item 0 fails fast, items 1-2 succeed slowly.
    // Chunk 2: items 3-4 must never start.
    const operation = async (item: number): Promise<number> => {
      started.push(item);
      if (item === 0) {
        throw new Error('item 0 exploded');
      }
      await sleep(40);
      return item;
    };

    let batchError: BatchError | undefined;
    try {
      await executor.execute([0, 1, 2, 3, 4], operation, {
        continueOnError: false,
        maxConcurrent: 3
      });
    } catch (e) {
      batchError = e as BatchError;
    }

    expect(batchError).toBeInstanceOf(BatchError);
    const result = batchError!.result!;
    const successfulAtThrow = result.successful.length;
    const failedAtThrow = result.failed.length;

    // Siblings in the failing chunk had already settled when the error was
    // built: their outcomes are included, not lost.
    expect(failedAtThrow).toBe(1);
    expect(successfulAtThrow).toBe(2);
    expect(result.totalProcessed).toBe(3);

    // Later chunks never started.
    expect(started.sort()).toEqual([0, 1, 2]);

    // The result must not silently grow after being thrown.
    await sleep(80);
    expect(result.successful.length).toBe(successfulAtThrow);
    expect(result.failed.length).toBe(failedAtThrow);
    expect(started.length).toBe(3);
  });

  test('an aborted fail-fast batch stops sibling retries (no further attempts after abort)', async () => {
    const executor = new BatchOperationExecutor();
    const attempts: Record<number, number> = { 0: 0, 1: 0 };

    // Both items fail. Item 0 fails immediately and exhausts its retries
    // fast; item 1 fails slowly. Once the batch is aborted by item 0, item 1
    // must NOT keep retrying (each retry could re-broadcast a paid op).
    const operation = async (item: number): Promise<number> => {
      attempts[item]++;
      if (item === 0) {
        throw new Error('fast failure');
      }
      await sleep(60);
      throw new Error('slow failure');
    };

    await expect(
      executor.execute([0, 1], operation, {
        continueOnError: false,
        maxConcurrent: 2,
        retryCount: 3,
        retryDelay: 5
      })
    ).rejects.toThrow(BatchError);

    // Wait long enough that item 1's retries WOULD have run had they been
    // scheduled (attempt ~60ms each + backoff), then assert none were.
    await sleep(400);
    // Item 0 exhausted its retries (4 attempts). Item 1's first attempt was
    // already in flight when the abort happened, but no retry was scheduled.
    expect(attempts[0]).toBe(4);
    expect(attempts[1]).toBe(1);
  });

  test('an item sleeping in retry backoff does not start another attempt after the batch aborts', async () => {
    const executor = new BatchOperationExecutor();
    const attempts: Record<number, number> = { 0: 0, 1: 0 };

    // Timeline (retryCount=1, retryDelay=100):
    //  - item 0 fails instantly on every attempt: attempt 1 at t≈0, backoff
    //    100ms, attempt 2 at t≈100 -> exhausted -> aborts the batch at t≈100.
    //  - item 1 fails at t≈40 and enters its 100ms backoff sleep. The abort
    //    check BEFORE the sleep passes (nothing aborted yet at t≈40); the
    //    abort lands at t≈100 WHILE item 1 sleeps. On wake (t≈140) item 1
    //    must re-check the abort flag and NOT start attempt 2 — a retry here
    //    would re-run a paid/non-idempotent operation for a batch that has
    //    already failed.
    const operation = async (item: number): Promise<number> => {
      attempts[item]++;
      if (item === 0) {
        throw new Error('sibling fast failure');
      }
      await sleep(40);
      throw new Error('item 1 failure');
    };

    await expect(
      executor.execute([0, 1], operation, {
        continueOnError: false,
        maxConcurrent: 2,
        retryCount: 1,
        retryDelay: 100
      })
    ).rejects.toThrow(BatchError);

    // Wait past when item 1's retry WOULD have run had it been scheduled.
    await sleep(300);
    expect(attempts[0]).toBe(2);
    expect(attempts[1]).toBe(1);
  });

  test('continueOnError=true is unaffected: all items run, retries happen', async () => {
    const executor = new BatchOperationExecutor();
    const attempts: Record<number, number> = { 0: 0, 1: 0, 2: 0 };

    const operation = async (item: number): Promise<number> => {
      attempts[item]++;
      if (item === 1 && attempts[1] < 2) {
        throw new Error('flaky');
      }
      return item;
    };

    const result = await executor.execute([0, 1, 2], operation, {
      continueOnError: true,
      maxConcurrent: 2,
      retryCount: 2,
      retryDelay: 1
    });

    expect(result.successful.length).toBe(3);
    expect(result.failed.length).toBe(0);
    expect(attempts[1]).toBe(2);
  });
});
