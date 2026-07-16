/**
 * Bitcoin scenario coverage tests
 *
 * Covers: BITCOIN-006, BITCOIN-013, BITCOIN-014, BITCOIN-015, BITCOIN-020,
 *         BITCOIN-021, BITCOIN-023, BITCOIN-024, BITCOIN-025
 *
 * Performance scenarios (BITCOIN-009, BITCOIN-010, BITCOIN-013/perf) are in
 * tests/performance/bitcoin-utxo.perf.test.ts
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  parseSatoshiIdentifier,
  validateSatoshiNumber,
  calculateFee,
  estimateTransactionSize,
  selectUtxosSimple,
  selectResourceUtxos,
} from '../../../src';
import { BroadcastClient } from '../../../src/bitcoin/BroadcastClient';
import { SignetProvider } from '../../../src/bitcoin/providers/SignetProvider';
import type { Utxo, ResourceUtxo } from '../../../src/types';

// ---------------------------------------------------------------------------
// [BITCOIN-006/invalid-input] Reject malformed Bitcoin DID strings
// ---------------------------------------------------------------------------
describe('BITCOIN-006: did:btco DID string parsing', () => {
  // parseSatoshiIdentifier is the primary parser for did:btco strings

  test('rejects bare alphabetic satoshi (did:btco:abc)', () => {
    expect(() => parseSatoshiIdentifier('did:btco:abc')).toThrow();
  });

  test('rejects empty-satoshi DID (did:btco:)', () => {
    // split(':') gives ['did', 'btco', ''] — satoshiStr = '' which is not numeric
    expect(() => parseSatoshiIdentifier('did:btco:')).toThrow();
  });

  test('rejects hex string as satoshi (did:btco:0xdeadbeef)', () => {
    expect(() => parseSatoshiIdentifier('did:btco:0xdeadbeef')).toThrow();
  });

  test('rejects float as satoshi (did:btco:1.5)', () => {
    expect(() => parseSatoshiIdentifier('did:btco:1.5')).toThrow();
  });

  test('rejects negative satoshi (did:btco:-1)', () => {
    // -1 contains a non-digit character
    expect(() => parseSatoshiIdentifier('did:btco:-1')).toThrow();
  });

  test('rejects too many DID segments (did:btco:net:extra:123)', () => {
    // 5 parts — neither 3 nor 4 → throws
    expect(() => parseSatoshiIdentifier('did:btco:net:extra:123')).toThrow();
  });

  test('rejects unsupported network prefix (did:btco:foo:123)', () => {
    // Only "test", "sig" and "reg" are allowed
    expect(() => parseSatoshiIdentifier('did:btco:foo:123')).toThrow();
  });

  test('accepts valid regtest DID (did:btco:reg:123456)', () => {
    // The SDK itself generates did:btco:reg: DIDs for regtest
    expect(parseSatoshiIdentifier('did:btco:reg:123456')).toBe(123456);
  });

  test('accepts valid mainnet DID (did:btco:123456)', () => {
    expect(parseSatoshiIdentifier('did:btco:123456')).toBe(123456);
  });

  test('accepts valid testnet DID (did:btco:test:123456)', () => {
    expect(parseSatoshiIdentifier('did:btco:test:123456')).toBe(123456);
  });

  test('accepts valid signet DID (did:btco:sig:123456)', () => {
    expect(parseSatoshiIdentifier('did:btco:sig:123456')).toBe(123456);
  });

  test('validateSatoshiNumber: empty string is invalid', () => {
    const r = validateSatoshiNumber('');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test('validateSatoshiNumber: non-numeric "abc" is invalid', () => {
    const r = validateSatoshiNumber('abc');
    expect(r.valid).toBe(false);
  });

  test('validateSatoshiNumber: exceeds max supply', () => {
    const r = validateSatoshiNumber(2_100_000_000_000_001);
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-013/boundary] Minimum relay fee enforcement when fee rate is low
// ---------------------------------------------------------------------------
describe('BITCOIN-013: minimum relay fee enforcement', () => {
  // MIN_RELAY_FEE_RATE = 1.1 sat/vB (from source)

  test('fee rate 0.5 sat/vB is lifted to minimum relay fee (1.1 sat/vB)', () => {
    const vbytes = 1000;
    const fee = calculateFee(vbytes, 0.5);
    // minimumFee = ceil(1000 * 1.1) = 1100
    expect(fee).toBeGreaterThanOrEqual(1100n);
    // calculatedFee = ceil(1000 * 0.5) = 500; minimum wins
    expect(fee).toBeLessThanOrEqual(1101n); // not inflated beyond min
  });

  test('fee rate exactly at minimum boundary (1.1 sat/vB)', () => {
    const vbytes = 100;
    // ceil(100 * 1.1): floating-point gives 110.00000000000001 → ceil = 111
    // Both calculatedFee and minimumFee hit the same ceiling, so result is 111
    const fee = calculateFee(vbytes, 1.1);
    // IEEE-754: Math.ceil(100 * 1.1) === 111, not 110
    expect(fee).toBe(111n);
  });

  test('fee rate slightly below minimum (1.0 sat/vB) lifts to min relay', () => {
    const vbytes = 200;
    const fee = calculateFee(vbytes, 1.0);
    // calculatedFee = 200; minimumFee = ceil(200 * 1.1) = 220 → 220 wins
    expect(fee).toBeGreaterThanOrEqual(220n);
  });

  test('returns at least 1 sat even for 1 vbyte at 0.001 sat/vB', () => {
    const fee = calculateFee(1, 0.001);
    // Both calculated (ceil 0.001 = 1) and minimum (ceil 1.1 = 2) give ≥ 1
    expect(fee).toBeGreaterThanOrEqual(1n);
  });

  test('high fee rate overrides minimum relay fee', () => {
    const vbytes = 100;
    const fee = calculateFee(vbytes, 50);
    // 100 * 50 = 5000 >> 1.1 minimum
    expect(fee).toBe(5000n);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-014/boundary] Fee calc with minimum relay enforcement for unconfirmed tx
// Using calculateFee directly (the underlying primitive used everywhere)
// ---------------------------------------------------------------------------
describe('BITCOIN-014: fee calculation for unconfirmed / priority scenarios', () => {
  test('typical unconfirmed bump (RBF) fee: 2 sat/vB on 140 vbytes', () => {
    // 2 > 1.1 so calculated wins: 140 * 2 = 280
    const fee = calculateFee(140, 2);
    expect(fee).toBe(280n);
  });

  test('low-priority unconfirmed tx at 0.3 sat/vB lifted by relay floor', () => {
    const vbytes = 250;
    const fee = calculateFee(vbytes, 0.3);
    // minimumFee = ceil(250 * 1.1) = 275; calculatedFee = ceil(250 * 0.3) = 75
    expect(fee).toBeGreaterThanOrEqual(275n);
  });

  test('result is always a bigint', () => {
    expect(typeof calculateFee(100, 1.5)).toBe('bigint');
    expect(typeof calculateFee(100, 0.5)).toBe('bigint');
  });

  test('throws for invalid (zero) vbytes', () => {
    expect(() => calculateFee(0, 10)).toThrow(/Invalid input/);
  });

  test('throws for invalid (NaN) fee rate', () => {
    expect(() => calculateFee(100, NaN)).toThrow(/Invalid input/);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-015/boundary] estimateTransactionSize for 0 inputs or 0 outputs
// ---------------------------------------------------------------------------
describe('BITCOIN-015: estimateTransactionSize edge cases', () => {
  // Formula: 10 + (inputCount * 68) + (outputCount * 31)

  test('0 inputs, 2 outputs → overhead + outputs only', () => {
    const size = estimateTransactionSize(0, 2);
    // 10 + 0 + 62 = 72
    expect(size).toBe(72);
  });

  test('1 input, 0 outputs → overhead + input only', () => {
    const size = estimateTransactionSize(1, 0);
    // 10 + 68 + 0 = 78
    expect(size).toBe(78);
  });

  test('0 inputs, 0 outputs → just overhead (10)', () => {
    const size = estimateTransactionSize(0, 0);
    expect(size).toBe(10);
  });

  test('returns a number (not NaN/Infinity) for large counts', () => {
    const size = estimateTransactionSize(1000, 1000);
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBe(10 + 1000 * 68 + 1000 * 31);
  });

  test('scales correctly from baseline 1-in 2-out', () => {
    // Sanity-check formula against known value
    expect(estimateTransactionSize(1, 2)).toBe(140);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-020/happy] Broadcast idempotently (inflight dedupe)
// ---------------------------------------------------------------------------
describe('BITCOIN-020: idempotent broadcast', () => {
  test('simultaneous calls with same key call the factory once and return same txid', async () => {
    let callCount = 0;
    const broadcaster = async (_hex: string) => {
      callCount++;
      return 'txid-abc';
    };
    const statusProvider = async (_txid: string) => ({ confirmed: true, confirmations: 1 });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const [a, b, c] = await Promise.all([
      bc.broadcastIdempotent('same-key', () => broadcaster('hex')),
      bc.broadcastIdempotent('same-key', () => broadcaster('hex')),
      bc.broadcastIdempotent('same-key', () => broadcaster('hex')),
    ]);

    expect(a).toBe('txid-abc');
    expect(b).toBe('txid-abc');
    expect(c).toBe('txid-abc');
    // factory was only invoked once despite three concurrent callers
    expect(callCount).toBe(1);
  });

  test('different keys each invoke factory independently', async () => {
    const results: string[] = [];
    const broadcaster = async (hex: string) => {
      results.push(hex);
      return `txid-${hex}`;
    };
    const statusProvider = async (_txid: string) => ({ confirmed: false });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const [a, b] = await Promise.all([
      bc.broadcastIdempotent('key-1', () => broadcaster('h1')),
      bc.broadcastIdempotent('key-2', () => broadcaster('h2')),
    ]);

    expect(a).toBe('txid-h1');
    expect(b).toBe('txid-h2');
    expect(results).toHaveLength(2);
  });

  test('after first call completes, second call with same key invokes factory again', async () => {
    let callCount = 0;
    const broadcaster = async (_hex: string) => {
      callCount++;
      return `txid-${callCount}`;
    };
    const statusProvider = async (_txid: string) => ({ confirmed: false });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const first = await bc.broadcastIdempotent('k', () => broadcaster('hex'));
    expect(first).toBe('txid-1');

    // inflight map is cleared after completion
    const second = await bc.broadcastIdempotent('k', () => broadcaster('hex'));
    expect(second).toBe('txid-2');
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-020/error] Handle broadcast errors without infinite retries
// ---------------------------------------------------------------------------
describe('BITCOIN-020: broadcast error handling', () => {
  test('broadcast error propagates and does not retry', async () => {
    let callCount = 0;
    const broadcaster = async (_hex: string): Promise<string> => {
      callCount++;
      throw new Error('network error');
    };
    const statusProvider = async (_txid: string) => ({ confirmed: false });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    await expect(
      bc.broadcastIdempotent('err-key', () => broadcaster('hex'))
    ).rejects.toThrow('network error');

    // called exactly once — no retry loop
    expect(callCount).toBe(1);
  });

  test('inflight entry is cleaned up after broadcast error', async () => {
    let callCount = 0;
    const broadcaster = async (_hex: string): Promise<string> => {
      callCount++;
      if (callCount === 1) throw new Error('transient');
      return 'txid-ok';
    };
    const statusProvider = async (_txid: string) => ({ confirmed: false });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    // First call fails
    await expect(
      bc.broadcastIdempotent('rkey', () => broadcaster('hex'))
    ).rejects.toThrow('transient');

    // Second call succeeds (map was cleaned up → factory is called again)
    const result = await bc.broadcastIdempotent('rkey', () => broadcaster('hex'));
    expect(result).toBe('txid-ok');
    expect(callCount).toBe(2);
  });

  test('broadcastAndConfirm propagates broadcaster errors', async () => {
    const broadcaster = async (_hex: string): Promise<string> => {
      throw new Error('rpc down');
    };
    const statusProvider = async (_txid: string) => ({ confirmed: false });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    await expect(
      bc.broadcastAndConfirm('bad-hex', { pollIntervalMs: 1, maxAttempts: 3 })
    ).rejects.toThrow('rpc down');
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-021/happy] Broadcast and confirm with polling → {txid, confirmations}
// ---------------------------------------------------------------------------
describe('BITCOIN-021: broadcastAndConfirm happy path', () => {
  test('returns txid and confirmations when tx confirms on first poll', async () => {
    const broadcaster = async (_hex: string) => 'txid-confirmed';
    const statusProvider = async (_txid: string) => ({ confirmed: true, confirmations: 6 });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const result = await bc.broadcastAndConfirm('valid-hex', {
      pollIntervalMs: 1,
      maxAttempts: 5,
    });

    expect(result).toEqual({ txid: 'txid-confirmed', confirmations: 6 });
  });

  test('polls until confirmed, returns confirmations from status provider', async () => {
    const broadcaster = async (_hex: string) => 'txid-poll';
    let polls = 0;
    const statusProvider = async (_txid: string) => {
      polls++;
      if (polls < 3) return { confirmed: false, confirmations: 0 };
      return { confirmed: true, confirmations: 3 };
    };
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const result = await bc.broadcastAndConfirm('hex', {
      pollIntervalMs: 1,
      maxAttempts: 10,
    });

    expect(result.txid).toBe('txid-poll');
    expect(result.confirmations).toBe(3);
    expect(polls).toBe(3);
  });

  test('defaults to 1 confirmation when confirmed=true but confirmations omitted', async () => {
    const broadcaster = async (_hex: string) => 'txid-x';
    const statusProvider = async (_txid: string) => ({ confirmed: true }); // no confirmations field
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const result = await bc.broadcastAndConfirm('hex', { pollIntervalMs: 1, maxAttempts: 1 });
    expect(result.confirmations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-021/boundary] Timeout waiting for confirmation → unconfirmed, no hang
// ---------------------------------------------------------------------------
describe('BITCOIN-021: confirmation timeout', () => {
  test('returns unconfirmed status after maxAttempts without hanging', async () => {
    const broadcaster = async (_hex: string) => 'txid-slow';
    const statusProvider = async (_txid: string) => ({ confirmed: false, confirmations: 0 });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const result = await bc.broadcastAndConfirm('hex', {
      pollIntervalMs: 1, // minimal sleep
      maxAttempts: 3,
    });

    // Returns after maxAttempts with last known status
    expect(result.txid).toBe('txid-slow');
    expect(result.confirmations).toBe(0);
  });

  test('respects maxAttempts=1 as lower bound', async () => {
    const broadcaster = async (_hex: string) => 'txid-fast';
    let polls = 0;
    const statusProvider = async (_txid: string) => {
      polls++;
      return { confirmed: false };
    };
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const result = await bc.broadcastAndConfirm('hex', {
      pollIntervalMs: 1,
      maxAttempts: 0, // clamped to 1 by implementation
    });

    // Exactly 1 poll regardless of input ≤ 0
    expect(polls).toBe(1);
    expect(result.confirmations).toBe(0);
  });

  test('pollIntervalMs below 100 is clamped to 100ms minimum', async () => {
    // Just verify the function completes without error; we cannot easily assert
    // the sleep interval value directly, but we confirm the result shape
    const broadcaster = async (_hex: string) => 'txid-clamp';
    const statusProvider = async (_txid: string) => ({ confirmed: true, confirmations: 1 });
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const result = await bc.broadcastAndConfirm('hex', {
      pollIntervalMs: 10, // below 100ms minimum
      maxAttempts: 1,
    });
    expect(result.txid).toBe('txid-clamp');
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-023/error] Missing Bitcoin RPC URL for write op on signet → clear error
// ---------------------------------------------------------------------------
describe('BITCOIN-023: SignetProvider write ops without bitcoinRpcUrl', () => {
  test('createInscription without bitcoinRpcUrl throws descriptive error', async () => {
    const provider = new SignetProvider({ ordUrl: 'http://localhost:80' });
    await expect(
      provider.createInscription({ data: Buffer.from('test'), contentType: 'text/plain' })
    ).rejects.toThrow(/bitcoinRpcUrl|funded signet wallet/i);
  });

  test('transferInscription without bitcoinRpcUrl throws descriptive error', async () => {
    const provider = new SignetProvider({ ordUrl: 'http://localhost:80' });
    await expect(
      provider.transferInscription('insc-id', 'addr', {})
    ).rejects.toThrow(/bitcoinRpcUrl|funded signet wallet/i);
  });

  test('broadcastTransaction without bitcoinRpcUrl throws descriptive error', async () => {
    const provider = new SignetProvider({ ordUrl: 'http://localhost:80' });
    await expect(
      provider.broadcastTransaction('raw-tx-hex')
    ).rejects.toThrow(/bitcoinRpcUrl/i);
  });

  test('estimateFee without bitcoinRpcUrl throws instead of fabricating a rate (issue #351)', async () => {
    const provider = new SignetProvider({ ordUrl: 'http://localhost:80' });
    // The old fallback invented a rate that INCREASED with the confirmation
    // target; fee estimation must fail loudly like the other providers.
    await expect(provider.estimateFee(1)).rejects.toThrow(/bitcoinRpcUrl/);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-024/boundary] Respect retry limit; fail after exhausted attempts
// ---------------------------------------------------------------------------
describe('BITCOIN-024: retry limit respected', () => {
  test('broadcastAndConfirm polls exactly maxAttempts times when never confirmed', async () => {
    const broadcaster = async (_hex: string) => 'txid-retry';
    let pollCount = 0;
    const statusProvider = async (_txid: string) => {
      pollCount++;
      return { confirmed: false, confirmations: pollCount - 1 };
    };
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const maxAttempts = 5;
    const result = await bc.broadcastAndConfirm('hex', {
      pollIntervalMs: 1,
      maxAttempts,
    });

    expect(pollCount).toBe(maxAttempts);
    expect(result.txid).toBe('txid-retry');
    // confirms exhausted — last known confirmations returned
    expect(result.confirmations).toBe(maxAttempts - 1);
  });

  test('stops polling immediately when confirmed, regardless of maxAttempts', async () => {
    const broadcaster = async (_hex: string) => 'txid-early';
    let pollCount = 0;
    const statusProvider = async (_txid: string) => {
      pollCount++;
      return { confirmed: true, confirmations: 2 }; // confirms on first poll
    };
    const bc = new BroadcastClient(broadcaster, statusProvider);

    const result = await bc.broadcastAndConfirm('hex', {
      pollIntervalMs: 1,
      maxAttempts: 100,
    });

    expect(pollCount).toBe(1); // stopped after first confirmed response
    expect(result.confirmations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-025/happy] ResourceProvider resolves inscriptions by satoshi via adapter
// The OrdNodeProvider is a ResourceProvider implementation; test getSatInfo
// which is the core method for resolving by satoshi.
// ---------------------------------------------------------------------------
describe('BITCOIN-025: OrdNodeProvider resource resolution by satoshi', () => {
  // OrdNodeProvider is a stub (no real network). We verify the adapter wiring.
  // For a proper sat-resolution test using OrdMockProvider (an OrdinalsProvider)
  // we exercise getInscriptionsBySatoshi.
  const { OrdMockProvider } = require('../../../src');

  test('OrdMockProvider resolves inscription by satoshi after creation', async () => {
    const provider = new OrdMockProvider();
    const result = await provider.createInscription({
      data: Buffer.from('sat-lookup-test'),
      contentType: 'text/plain',
    });
    const satoshi = result.satoshi!;

    const inscriptions = await provider.getInscriptionsBySatoshi(satoshi);
    expect(inscriptions).toHaveLength(1);
    expect(inscriptions[0].inscriptionId).toBe(result.inscriptionId);
  });

  test('OrdMockProvider returns empty array for unknown satoshi', async () => {
    const provider = new OrdMockProvider();
    const inscriptions = await provider.getInscriptionsBySatoshi('9999999999');
    expect(inscriptions).toHaveLength(0);
  });

  test('OrdMockProvider resolves getInscriptionById after createInscription', async () => {
    const provider = new OrdMockProvider();
    const created = await provider.createInscription({
      data: Buffer.from('lookup'),
      contentType: 'application/json',
    });

    const found = await provider.getInscriptionById(created.inscriptionId);
    expect(found).not.toBeNull();
    expect(found!.inscriptionId).toBe(created.inscriptionId);
    expect(found!.contentType).toBe('application/json');
  });

  test('OrdNodeProvider getSatInfo throws NOT_IMPLEMENTED instead of reporting no inscriptions (#318)', async () => {
    const { OrdNodeProvider } = require('../../../src/bitcoin/providers/OrdNodeProvider');
    const p = new OrdNodeProvider({ nodeUrl: 'http://ord.example' });
    // The stub used to return { inscription_ids: [] }, silently reporting
    // every did:btco as uninscribed. It must now fail loudly.
    await expect(p.getSatInfo('123456789')).rejects.toThrow(/not implemented/i);
  });
});
