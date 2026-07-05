/**
 * Utils/Adapters scenario tests
 *
 * Covers:
 *   UTILS-VERIFY-001  StructuredError null/empty details
 *   UTILS-VERIFY-004  MetricsCollector.track() with async op
 *   UTILS-VERIFY-008  base58 roundtrip (utils/encoding)
 *   UTILS-VERIFY-008  multibase base58btc (utils/encoding)
 *   UTILS-VERIFY-008  Multikey Ed25519 roundtrip (crypto/Multikey)
 *   UTILS-VERIFY-013  CircuitBreaker error details
 *   UTILS-VERIFY-014  Retry maxDelayMs cap
 *   UTILS-VERIFY-014  Retry onRetry callback signature
 *   UTILS-VERIFY-018  OrdinalsProvider interface defines required methods
 *   UTILS-VERIFY-020  OrdHttpProvider validates baseUrl in constructor
 *   UTILS-VERIFY-020  OrdHttpProvider builds URLs correctly
 */

import { describe, test, expect } from 'bun:test';

// ── Source imports ────────────────────────────────────────────────────────────
import { StructuredError } from '../../../src/utils/telemetry';
import { MetricsCollector } from '../../../src/utils/MetricsCollector';
import { base58, multibase } from '../../../src/utils/encoding';
import { multikey as cryptoMultikey } from '../../../src/crypto/Multikey';
import { CircuitBreaker } from '../../../src/utils/circuit-breaker';
import { withRetry } from '../../../src/utils/retry';
import type { OrdinalsProvider } from '../../../src/adapters/types';
import { OrdHttpProvider } from '../../../src/adapters/providers/OrdHttpProvider';

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-001  StructuredError null/empty details → details undefined
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-001: StructuredError null/empty details', () => {
  test('details is undefined when not provided', () => {
    const err = new StructuredError('E_001', 'no details');
    expect(err.details).toBeUndefined();
  });

  test('details is undefined when explicitly passed undefined', () => {
    const err = new StructuredError('E_003', 'explicit undefined', undefined);
    expect(err.details).toBeUndefined();
  });

  test('details is undefined for empty-message StructuredError', () => {
    const err = new StructuredError('E_004', '');
    expect(err.details).toBeUndefined();
    expect(err.code).toBe('E_004');
    expect(err.message).toBe('');
  });

  test('details is present when a non-empty object is provided', () => {
    const err = new StructuredError('E_005', 'with details', { key: 'value' });
    expect(err.details).toEqual({ key: 'value' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-004  MetricsCollector.track() with async op → recorded with timing
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-004: MetricsCollector.track() with async operation', () => {
  test('records the operation with count=1 and non-negative timing', async () => {
    const collector = new MetricsCollector();
    const result = await collector.track('my-op', async () => {
      // intentionally trivial – sub-ms is fine
      return 42;
    });

    expect(result).toBe(42);

    const m = collector.getOperationMetrics('my-op');
    expect(m).not.toBeNull();
    expect(m!.count).toBe(1);
    // performance.now() is >= 0; fast ops may record 0 on some clocks.
    expect(m!.totalTime).toBeGreaterThanOrEqual(0);
    expect(m!.minTime).toBeGreaterThanOrEqual(0);
    expect(m!.maxTime).toBeGreaterThanOrEqual(0);
    expect(m!.errorCount).toBe(0);
  });

  test('count increments on each call', async () => {
    const collector = new MetricsCollector();
    await collector.track('op', async () => 1);
    await collector.track('op', async () => 2);

    const m = collector.getOperationMetrics('op');
    expect(m!.count).toBe(2);
  });

  test('records errorCount when the operation throws, then re-throws', async () => {
    const collector = new MetricsCollector();

    await expect(
      collector.track('failing-op', async () => {
        throw new Error('bang');
      })
    ).rejects.toThrow('bang');

    const m = collector.getOperationMetrics('failing-op');
    expect(m).not.toBeNull();
    expect(m!.count).toBe(1);
    expect(m!.errorCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-008  base58 encode/decode roundtrip (utils/encoding)
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-008: base58 encode/decode roundtrip', () => {
  test('arbitrary bytes survive a roundtrip', () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x7f, 0x80, 0xff]);
    const encoded = base58.encode(original);
    expect(typeof encoded).toBe('string');
    const decoded = base58.decode(encoded);
    expect(decoded).toEqual(original);
  });

  test('single-byte value roundtrips', () => {
    const original = new Uint8Array([1]);
    expect(base58.decode(base58.encode(original))).toEqual(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-008  multibase encode/decode base58btc (utils/encoding)
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-008: multibase base58btc encode/decode', () => {
  test('encoded string starts with "z"', () => {
    const input = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    const encoded = multibase.encode(input, 'base58btc');
    expect(encoded[0]).toBe('z');
  });

  test('roundtrip: encode then decode returns original bytes', () => {
    const original = new Uint8Array(32).map((_, i) => (i * 7 + 13) & 0xff);
    const encoded = multibase.encode(original, 'base58btc');
    const decoded = multibase.decode(encoded);
    expect(decoded).toEqual(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-008  Multikey encode/decode Ed25519 public key (crypto/Multikey)
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-008: crypto/Multikey Ed25519 public key roundtrip', () => {
  const rawPub = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);

  test('encoded key starts with "z" (multibase base58btc prefix)', () => {
    const encoded = cryptoMultikey.encodePublicKey(rawPub, 'Ed25519');
    expect(encoded[0]).toBe('z');
  });

  test('decodePublicKey recovers original bytes and type', () => {
    const encoded = cryptoMultikey.encodePublicKey(rawPub, 'Ed25519');
    const { key, type } = cryptoMultikey.decodePublicKey(encoded);
    expect(type).toBe('Ed25519');
    expect(Array.from(key)).toEqual(Array.from(rawPub));
  });

  test('encodeMultibase / decodeMultibase roundtrip', () => {
    const data = new Uint8Array([10, 20, 30, 40]);
    const encoded = cryptoMultikey.encodeMultibase(data);
    expect(encoded[0]).toBe('z');
    const decoded = cryptoMultikey.decodeMultibase(encoded);
    expect(decoded).toEqual(data);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-013  CircuitBreaker CIRCUIT_OPEN error details
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-013: CircuitBreaker error details when OPEN', () => {
  test('CIRCUIT_OPEN error includes state, consecutiveFailures, resetTimeoutMs, msSinceLastFailure', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5_000 });

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(breaker.getState()).toBe('OPEN');

    let caught: StructuredError | undefined;
    try {
      await breaker.execute(() => Promise.resolve('should not run'));
    } catch (err) {
      caught = err as StructuredError;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(StructuredError);
    expect(caught!.code).toBe('CIRCUIT_OPEN');

    const d = caught!.details as Record<string, unknown>;
    expect(d).toBeDefined();
    // state field
    expect(d.state).toBe('OPEN');
    // failureCount / consecutiveFailures
    expect(d.consecutiveFailures).toBe(2);
    // resetTimeoutMs
    expect(d.resetTimeoutMs).toBe(5_000);
    // msSinceLastFailure must be a non-negative number
    expect(typeof d.msSinceLastFailure).toBe('number');
    expect(d.msSinceLastFailure as number).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-014  Retry maxDelayMs cap
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-014: Retry maxDelayMs cap', () => {
  test('delay values passed to onRetry never exceed maxDelayMs', async () => {
    const maxDelayMs = 50;
    const delays: number[] = [];

    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 4) throw new Error('transient');
        return 'done';
      },
      {
        maxRetries: 5,
        baseDelayMs: 1_000, // very large base — would blow past cap without it
        backoffFactor: 10,
        jitterFactor: 0,
        maxDelayMs,
        onRetry: (_attempt, delayMs) => delays.push(delayMs),
      }
    );

    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(maxDelayMs);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-014  Retry onRetry callback signature (attempt, delayMs, error)
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-014: Retry onRetry callback', () => {
  test('onRetry receives (attempt, delayMs, error) in order', async () => {
    const calls: Array<[number, number, unknown]> = [];
    const sentinel = new Error('transient');

    let n = 0;
    await withRetry(
      async () => {
        n++;
        if (n < 3) throw sentinel;
        return 'ok';
      },
      {
        maxRetries: 5,
        baseDelayMs: 1,
        backoffFactor: 2,
        jitterFactor: 0,
        onRetry: (attempt, delayMs, error) => calls.push([attempt, delayMs, error]),
      }
    );

    // Two failures → two onRetry calls
    expect(calls.length).toBe(2);

    // First callback: attempt=1
    expect(calls[0][0]).toBe(1);
    expect(typeof calls[0][1]).toBe('number');
    expect(calls[0][1]).toBeGreaterThanOrEqual(0);
    expect(calls[0][2]).toBe(sentinel);

    // Second callback: attempt=2
    expect(calls[1][0]).toBe(2);
    expect(calls[1][2]).toBe(sentinel);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-018  OrdinalsProvider interface defines required methods
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-018: OrdinalsProvider interface required methods', () => {
  /**
   * The interface is verified at compile time (TypeScript); this test
   * confirms that a concrete implementation satisfying the interface can be
   * constructed and that its required method names are present at runtime.
   */
  test('OrdHttpProvider (concrete impl) exposes all required OrdinalsProvider methods', () => {
    const provider: OrdinalsProvider = new OrdHttpProvider({ baseUrl: 'http://example.com' });

    // Required methods from the OrdinalsProvider interface
    const required: Array<keyof OrdinalsProvider> = [
      'getInscriptionById',
      'getInscriptionsBySatoshi',
      'broadcastTransaction',
      'getTransactionStatus',
      'estimateFee',
      'createInscription',
      'transferInscription',
    ];

    for (const method of required) {
      expect(typeof provider[method]).toBe('function');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-020  OrdHttpProvider validates baseUrl in constructor
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-020: OrdHttpProvider constructor validation', () => {
  test('throws when baseUrl is absent', () => {
    expect(() => new OrdHttpProvider({} as any)).toThrow('requires baseUrl');
  });

  test('throws when baseUrl is empty string', () => {
    expect(() => new OrdHttpProvider({ baseUrl: '' })).toThrow('requires baseUrl');
  });

  test('does not throw with a valid baseUrl', () => {
    expect(() => new OrdHttpProvider({ baseUrl: 'http://ord.local' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-020  OrdHttpProvider builds URLs correctly
// ─────────────────────────────────────────────────────────────────────────────
describe('UTILS-VERIFY-020: OrdHttpProvider URL construction', () => {
  /**
   * We verify URL building by stubbing globalThis.fetch and inspecting the
   * URL that OrdHttpProvider passes to it.  The provider fetches two URLs
   * for getInscriptionById: first the metadata endpoint, then the content.
   * We make the first fetch return a minimal JSON body so the second fetch
   * is attempted, and capture both.
   */
  test('builds inscription URL correctly from baseUrl without trailing slash', async () => {
    const fetchedUrls: string[] = [];
    const originalFetch = (globalThis as any).fetch;

    (globalThis as any).fetch = async (url: string) => {
      fetchedUrls.push(url);
      // Return a minimal valid response for metadata call
      const body = JSON.stringify({
        inscription_id: 'abc123',
        content_type: 'text/plain',
        content_url: 'http://ord.local/content/abc123',
        txid: 'txidabc',
        vout: 0,
        sat: 12345,
      });
      return {
        ok: true,
        json: async () => JSON.parse(body),
        // fetchJson materializes bytes (arrayBuffer), not res.json(), so the
        // stub must return the JSON body as real bytes.
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    };

    try {
      const provider = new OrdHttpProvider({ baseUrl: 'http://ord.local' });
      await provider.getInscriptionById('abc123');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }

    expect(fetchedUrls.length).toBeGreaterThan(0);
    // First call should be the metadata endpoint
    expect(fetchedUrls[0]).toBe('http://ord.local/inscription/abc123');
  });

  test('strips trailing slash from baseUrl', async () => {
    const fetchedUrls: string[] = [];
    const originalFetch = (globalThis as any).fetch;

    (globalThis as any).fetch = async (url: string) => {
      fetchedUrls.push(url);
      const body = JSON.stringify({
        inscription_id: 'xyz',
        content_type: 'text/plain',
        content_url: 'http://ord.local/content/xyz',
        txid: 'txidxyz',
        vout: 0,
        sat: 99,
      });
      return {
        ok: true,
        json: async () => JSON.parse(body),
        // fetchJson materializes bytes (arrayBuffer), not res.json(), so the
        // stub must return the JSON body as real bytes.
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    };

    try {
      const provider = new OrdHttpProvider({ baseUrl: 'http://ord.local/' });
      await provider.getInscriptionById('xyz');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }

    // Should NOT produce double slash
    expect(fetchedUrls[0]).toBe('http://ord.local/inscription/xyz');
  });

  test('estimateFee does not make network calls and returns positive value', async () => {
    const provider = new OrdHttpProvider({ baseUrl: 'http://ord.local' });
    const fee = await provider.estimateFee(6);
    expect(fee).toBeGreaterThan(0);
  });
});
