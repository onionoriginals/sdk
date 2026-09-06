import { describe, test, expect } from 'bun:test';
import { DemoCopyError, demoFailureMessage } from './Demo';
import { demo } from '../content';

// R15: a store or transport failure must never reach a visitor as a raw
// message. `HttpHostingStorageAdapter.put failed: 507` on screen is also a
// breach of GRADING.md's mechanical floor.
describe('demoFailureMessage', () => {
  test('a full/failed host write renders copy, not the adapter string', () => {
    const raw = 'HttpHostingStorageAdapter.put failed: 507 for demo.test/u/a/did.jsonl';
    const msg = demoFailureMessage(new Error(raw));
    // 507 is the durable per-user QUOTA (the anonymous store evicts instead).
    expect(msg).toBe(demo.hosting.quotaFull);
    expect(msg).not.toContain('HttpHostingStorageAdapter');
    expect(msg).not.toContain('507');
  });

  test('a host write that just failed renders the transient copy', () => {
    const msg = demoFailureMessage(
      new Error('HttpHostingStorageAdapter.put failed: 502 for demo.test/u/a/did.jsonl')
    );
    expect(msg).toBe(demo.hosting.unavailable);
    expect(msg).not.toContain('502');
  });

  test('a rate-limited host write gets its own copy', () => {
    const msg = demoFailureMessage(
      new Error('HttpHostingStorageAdapter.put failed: 429 for demo.test/u/a/did.jsonl')
    );
    expect(msg).toBe(demo.hosting.rateLimited);
  });

  test('a failed host READ renders copy too', () => {
    const msg = demoFailureMessage(
      new Error('DurableHostingStorageAdapter.get failed: 500 for demo.test/u/a/cel.json')
    );
    expect(msg).toBe(demo.hosting.unavailable);
  });

  test('any other failure falls back to copy, never the raw message', () => {
    const msg = demoFailureMessage(new Error('TypeError: x.y is not a function'));
    expect(msg).toBe(demo.failure);
  });

  test('a non-Error throw is copy as well', () => {
    expect(demoFailureMessage('boom')).toBe(demo.failure);
    expect(demoFailureMessage(undefined)).toBe(demo.failure);
  });

  test('copy the demo raised deliberately passes through unchanged', () => {
    expect(demoFailureMessage(new DemoCopyError(demo.deposit.needed))).toBe(demo.deposit.needed);
    expect(demoFailureMessage(new DemoCopyError(demo.session.expiredBody))).toBe(
      demo.session.expiredBody
    );
  });
});

describe('temporary-log caveat copy', () => {
  test('exists and says the anonymous log is not kept forever', () => {
    expect(typeof demo.hosting.temporaryNote).toBe('string');
    expect(demo.hosting.temporaryNote.length).toBeGreaterThan(0);
  });
});
