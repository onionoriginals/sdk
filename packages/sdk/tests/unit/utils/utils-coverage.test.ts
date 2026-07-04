/**
 * utils-coverage.test.ts
 *
 * Closes coverage gaps for Utils and Adapters.
 *
 * Scenarios:
 *   UTILS-VERIFY-006  EventLogger logs migration & transfer events with details
 *   UTILS-VERIFY-008  parseSatoshiIdentifier extracts satoshi from identifier string
 *   UTILS-VERIFY-009  utf8 encode/decode preserves Unicode roundtrip
 *   UTILS-VERIFY-017  OrdHttpProvider fee estimation (fetch stubbed; URL + parsed value asserted)
 *   UTILS-VERIFY-022  OrdMockProvider.transferInscription returns transfer tx info
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// ─── EventLogger ────────────────────────────────────────────────────────────
import { EventLogger } from '../../../src/utils/EventLogger';
import { Logger, type LogOutput, type LogEntry } from '../../../src/utils/Logger';
import { MetricsCollector } from '../../../src/utils/MetricsCollector';
import { EventEmitter } from '../../../src/events/EventEmitter';
import type {
  AssetMigratedEvent,
  AssetTransferredEvent,
} from '../../../src/events/types';
import type { OriginalsConfig } from '../../../src/types';

// ─── satoshi-validation ─────────────────────────────────────────────────────
import { parseSatoshiIdentifier } from '../../../src/utils/satoshi-validation';

// ─── encoding ───────────────────────────────────────────────────────────────
import { utf8 } from '../../../src/utils/encoding';

// ─── OrdHttpProvider ────────────────────────────────────────────────────────
import { OrdHttpProvider } from '../../../src/adapters/providers/OrdHttpProvider';

// ─── OrdMockProvider ────────────────────────────────────────────────────────
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeLogger(captured: LogEntry[]): Logger {
  const output: LogOutput = {
    write(entry: LogEntry) {
      captured.push(entry);
    },
  };
  const config: OriginalsConfig = {
    network: 'mainnet',
    defaultKeyType: 'ES256K',
    logging: { level: 'debug', outputs: [output] },
  };
  return new Logger('TestLogger', config);
}

// ────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-006: EventLogger logs migration & transfer events with details
// ────────────────────────────────────────────────────────────────────────────
describe('[UTILS-VERIFY-006] EventLogger — migration & transfer events', () => {
  let eventEmitter: EventEmitter;
  let captured: LogEntry[];
  let eventLogger: EventLogger;

  beforeEach(() => {
    captured = [];
    eventEmitter = new EventEmitter();
    const logger = makeLogger(captured);
    const metrics = new MetricsCollector();
    eventLogger = new EventLogger(logger, metrics);
    eventLogger.subscribeToEvents(eventEmitter);
  });

  test('logs asset:migrated with fromLayer, toLayer, and details', async () => {
    const event: AssetMigratedEvent = {
      type: 'asset:migrated',
      timestamp: new Date().toISOString(),
      asset: {
        id: 'did:peer:abc',
        fromLayer: 'did:peer',
        toLayer: 'did:webvh',
      },
      details: {
        transactionId: 'tx-migration-001',
        inscriptionId: 'insc-001',
      },
    };

    await eventEmitter.emit(event);

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const entry = captured.find((e) => e.message === 'Asset migrated');
    expect(entry).toBeDefined();
    expect((entry!.data as Record<string, unknown>).fromLayer).toBe('did:peer');
    expect((entry!.data as Record<string, unknown>).toLayer).toBe('did:webvh');
    expect((entry!.data as Record<string, unknown>).assetId).toBe('did:peer:abc');
    // details object should be included in the log data
    expect((entry!.data as Record<string, unknown>).details).toEqual(
      event.details,
    );
  });

  test('logs asset:transferred with from, to, and transactionId', async () => {
    const event: AssetTransferredEvent = {
      type: 'asset:transferred',
      timestamp: new Date().toISOString(),
      asset: {
        id: 'did:btco:999',
        layer: 'did:btco',
      },
      from: 'bc1qsender',
      to: 'bc1qrecipient',
      transactionId: 'tx-transfer-007',
    };

    await eventEmitter.emit(event);

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const entry = captured.find((e) => e.message === 'Asset transferred');
    expect(entry).toBeDefined();
    expect((entry!.data as Record<string, unknown>).from).toBe('bc1qsender');
    expect((entry!.data as Record<string, unknown>).to).toBe('bc1qrecipient');
    expect((entry!.data as Record<string, unknown>).transactionId).toBe(
      'tx-transfer-007',
    );
    expect((entry!.data as Record<string, unknown>).assetId).toBe(
      'did:btco:999',
    );
  });

  test('migration details are undefined-safe (no details field)', async () => {
    const event: AssetMigratedEvent = {
      type: 'asset:migrated',
      timestamp: new Date().toISOString(),
      asset: {
        id: 'did:peer:xyz',
        fromLayer: 'did:webvh',
        toLayer: 'did:btco',
      },
      // details intentionally omitted
    };

    await eventEmitter.emit(event);

    const entry = captured.find((e) => e.message === 'Asset migrated');
    expect(entry).toBeDefined();
    // details should be undefined when not provided
    expect((entry!.data as Record<string, unknown>).details).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-008: parseSatoshiIdentifier extracts satoshi from identifier
// ────────────────────────────────────────────────────────────────────────────
describe('[UTILS-VERIFY-008] parseSatoshiIdentifier', () => {
  test('parses a plain numeric string', () => {
    expect(parseSatoshiIdentifier('123456')).toBe(123456);
  });

  test('parses a mainnet did:btco DID', () => {
    expect(parseSatoshiIdentifier('did:btco:78901')).toBe(78901);
  });

  test('parses a testnet did:btco DID (did:btco:test:satoshi)', () => {
    expect(parseSatoshiIdentifier('did:btco:test:500000')).toBe(500000);
  });

  test('parses a signet did:btco DID (did:btco:sig:satoshi)', () => {
    expect(parseSatoshiIdentifier('did:btco:sig:999')).toBe(999);
  });

  test('returns 0 for the genesis satoshi', () => {
    expect(parseSatoshiIdentifier('0')).toBe(0);
  });

  test('returns the maximum supply satoshi', () => {
    // 2,099,999,997,689,999 — the last satoshi ordinal ever mined
    expect(parseSatoshiIdentifier('2099999997689999')).toBe(2_099_999_997_689_999);
  });

  test('throws for an invalid did:btco network prefix', () => {
    expect(() => parseSatoshiIdentifier('did:btco:mainnet:123')).toThrow();
  });

  test('throws for a negative number string', () => {
    expect(() => parseSatoshiIdentifier('-1')).toThrow();
  });

  test('throws for an empty string', () => {
    expect(() => parseSatoshiIdentifier('')).toThrow();
  });

  test('throws for a decimal string', () => {
    expect(() => parseSatoshiIdentifier('1.5')).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-009: utf8 encode/decode preserves Unicode roundtrip
// ────────────────────────────────────────────────────────────────────────────
describe('[UTILS-VERIFY-009] utf8 encode/decode Unicode roundtrip', () => {
  const cases: Array<[string, string]> = [
    ['ASCII text', 'Hello, World!'],
    ['emoji', '🌍🚀💡'],
    ['Japanese', '日本語テスト'],
    ['Korean', '안녕하세요'],
    ['Arabic', 'مرحباً بالعالم'],
    ['Chinese', '你好，世界！'],
    ['mixed multilingual', 'Héllo Wörld — こんにちは — 😊'],
    ['null character', '\0'],
    ['surrogate pair: 𝄞 (musical symbol G clef)', '𝄞'],
    ['empty string', ''],
  ];

  for (const [label, original] of cases) {
    test(`roundtrip: ${label}`, () => {
      const encoded = utf8.encode(original);
      const decoded = utf8.decode(encoded);
      expect(decoded).toBe(original);
    });
  }

  test('encode produces a Uint8Array', () => {
    const result = utf8.encode('abc');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(3);
  });

  test('encode multi-byte character produces correct byte count', () => {
    // '€' is U+20AC — 3 bytes in UTF-8
    const result = utf8.encode('€');
    expect(result.length).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-017: OrdHttpProvider — fetch is stubbed; URL + response parsed
//
// NOTE: OrdHttpProvider.estimateFee() is a pure calculation (5 * max(1, blocks))
// and does NOT call fetch.  The fetch-stub scenario is instead exercised via
// getInscriptionsBySatoshi(), which is the only read-path that hits the
// configured baseUrl and parses a structured JSON response.  We assert both:
//   (a) the constructed request URL
//   (b) the parsed return value
// This satisfies the intent of UTILS-VERIFY-017 without any real network call.
// ────────────────────────────────────────────────────────────────────────────
describe('[UTILS-VERIFY-017] OrdHttpProvider — fetch stub; URL + parsed result', () => {
  const BASE_URL = 'https://ord.signet.example.invalid';
  let provider: OrdHttpProvider;
  let originalFetch: unknown;

  beforeEach(() => {
    originalFetch = (globalThis as Record<string, unknown>).fetch;
    provider = new OrdHttpProvider({ baseUrl: BASE_URL });
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = originalFetch as typeof fetch;
  });

  test('estimateFee returns 5 * max(1, blocks) without network call (pure calc)', async () => {
    // Confirm the pure-calculation path: any fetch stub should never be called.
    let fetchCalled = false;
    (globalThis as Record<string, unknown>).fetch = async () => {
      fetchCalled = true;
      throw new Error('unexpected network call');
    };

    const fee1 = await provider.estimateFee(1);
    const fee3 = await provider.estimateFee(3);
    const fee0 = await provider.estimateFee(0); // blocks=0 → max(1,0)=1

    expect(fee1).toBe(5);   // 5 * 1
    expect(fee3).toBe(15);  // 5 * 3
    expect(fee0).toBe(5);   // 5 * max(1,0) = 5
    expect(fetchCalled).toBe(false);
  });

  test('getInscriptionsBySatoshi hits correct URL and returns parsed inscription ids', async () => {
    const capturedUrls: string[] = [];
    const mockResponse = {
      inscription_ids: ['insc-aaa', 'insc-bbb'],
    };

    (globalThis as Record<string, unknown>).fetch = async (url: string, _opts?: unknown) => {
      capturedUrls.push(url);
      return {
        ok: true,
        json: async () => mockResponse,
      };
    };

    const satoshi = '123456789';
    const result = await provider.getInscriptionsBySatoshi(satoshi);

    // URL must include the satoshi path segment
    expect(capturedUrls.length).toBe(1);
    expect(capturedUrls[0]).toBe(`${BASE_URL}/sat/${satoshi}`);

    // Parsed result should map inscription_ids to objects
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ inscriptionId: 'insc-aaa' });
    expect(result[1]).toEqual({ inscriptionId: 'insc-bbb' });
  });

  test('getInscriptionsBySatoshi returns [] when server responds not-ok', async () => {
    (globalThis as Record<string, unknown>).fetch = async () => ({
      ok: false,
      json: async () => null,
    });

    const result = await provider.getInscriptionsBySatoshi('99');
    expect(result).toEqual([]);
  });

  test('getInscriptionsBySatoshi returns [] when inscription_ids is missing', async () => {
    (globalThis as Record<string, unknown>).fetch = async () => ({
      ok: true,
      json: async () => ({ sat: '99' }), // no inscription_ids field
    });

    const result = await provider.getInscriptionsBySatoshi('99');
    expect(result).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// UTILS-VERIFY-022: OrdMockProvider.transferInscription returns transfer tx info
// ────────────────────────────────────────────────────────────────────────────
describe('[UTILS-VERIFY-022] OrdMockProvider.transferInscription', () => {
  let provider: OrdMockProvider;

  beforeEach(() => {
    provider = new OrdMockProvider();
  });

  async function inscribe(p: OrdMockProvider): Promise<string> {
    const result = await p.createInscription({
      data: Buffer.from('test content'),
      contentType: 'text/plain',
    });
    return result.inscriptionId;
  }

  test('returns a txid string for a known inscription', async () => {
    const inscriptionId = await inscribe(provider);
    const tx = await provider.transferInscription(
      inscriptionId,
      'bc1qrecipient',
    );
    expect(typeof tx.txid).toBe('string');
    expect(tx.txid).toMatch(/^tx-/);
  });

  test('result contains vin with previous txid and vout', async () => {
    const inscriptionId = await inscribe(provider);
    const tx = await provider.transferInscription(
      inscriptionId,
      'bc1qrecipient',
    );
    expect(Array.isArray(tx.vin)).toBe(true);
    expect(tx.vin.length).toBeGreaterThanOrEqual(1);
    expect(typeof tx.vin[0].txid).toBe('string');
    expect(typeof tx.vin[0].vout).toBe('number');
  });

  test('result contains vout with value and scriptPubKey', async () => {
    const inscriptionId = await inscribe(provider);
    const tx = await provider.transferInscription(
      inscriptionId,
      'bc1qrecipient',
    );
    expect(Array.isArray(tx.vout)).toBe(true);
    expect(tx.vout.length).toBeGreaterThanOrEqual(1);
    expect(tx.vout[0].value).toBe(546); // dust limit
    expect(typeof tx.vout[0].scriptPubKey).toBe('string');
  });

  test('result contains numeric fee', async () => {
    const inscriptionId = await inscribe(provider);
    const tx = await provider.transferInscription(
      inscriptionId,
      'bc1qrecipient',
    );
    expect(typeof tx.fee).toBe('number');
    expect(tx.fee).toBeGreaterThan(0);
  });

  test('result carries satoshi from the original inscription record', async () => {
    const inscriptionId = await inscribe(provider);
    const tx = await provider.transferInscription(
      inscriptionId,
      'bc1qrecipient',
    );
    // satoshi is optional in the type but OrdMockProvider always sets it
    expect(tx.satoshi).toBeDefined();
    // must be a numeric string
    expect(/^\d+$/.test(tx.satoshi!)).toBe(true);
  });

  test('each transfer produces a unique txid', async () => {
    const id1 = await inscribe(provider);
    const id2 = await inscribe(provider);
    const tx1 = await provider.transferInscription(id1, 'bc1qaddr');
    const tx2 = await provider.transferInscription(id2, 'bc1qaddr');
    expect(tx1.txid).not.toBe(tx2.txid);
  });

  test('rejects with "inscription not found" for an unknown id', async () => {
    await expect(
      provider.transferInscription('nonexistent-id', 'bc1qaddr'),
    ).rejects.toThrow('inscription not found');
  });

  test('feeRate option is accepted without error', async () => {
    const inscriptionId = await inscribe(provider);
    // Should not throw even when feeRate option is supplied
    await expect(
      provider.transferInscription(inscriptionId, 'bc1qrecipient', {
        feeRate: 10,
      }),
    ).resolves.toBeDefined();
  });
});
