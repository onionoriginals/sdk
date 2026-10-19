import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { OrdHttpProvider, createOrdinalsProviderFromEnv } from '../../../src/adapters/providers/OrdHttpProvider';
import { StructuredError } from '../../../src/utils/telemetry';

/**
 * Pre-release blocker (#318 checkbox 3): OrdHttpProvider used to FABRICATE
 * on-chain success — broadcastTransaction returned the literal string
 * 'broadcast-txid', createInscription/transferInscription returned random
 * `insc-*`/`tx-*` ids with invented fee/vout data, estimateFee returned a
 * hardcoded linear estimate, and getTransactionStatus always reported
 * { confirmed: false }. Because createOrdinalsProviderFromEnv() hands this
 * class out when USE_LIVE_ORD_PROVIDER=true, an app enabling the live flag
 * would write fabricated txids/fees into provenance while reporting success.
 *
 * These methods must now fail loudly with a StructuredError whose code ends
 * in NOT_IMPLEMENTED (mirroring the OrdinalsClient hardening for #248), and
 * must never fabricate a txid, inscription id, fee, sat, or vout.
 */

describe('OrdHttpProvider write-path methods fail loudly instead of fabricating (#318)', () => {
  let provider: OrdHttpProvider;
  let originalFetch: unknown;
  let fetchCalled: boolean;

  beforeEach(() => {
    provider = new OrdHttpProvider({ baseUrl: 'http://ord.local' });
    originalFetch = (globalThis as Record<string, unknown>).fetch;
    fetchCalled = false;
    // None of the not-implemented methods may touch the network.
    (globalThis as Record<string, unknown>).fetch = async () => {
      fetchCalled = true;
      throw new Error('unexpected network call from a not-implemented method');
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).fetch = originalFetch as typeof fetch;
  });

  async function expectNotImplemented(promise: Promise<unknown>): Promise<StructuredError> {
    let caught: unknown;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructuredError);
    const err = caught as StructuredError;
    expect(err.code).toMatch(/NOT_IMPLEMENTED$/);
    expect(err.message).toMatch(/not implemented/i);
    return err;
  }

  test('broadcastTransaction throws NOT_IMPLEMENTED instead of returning "broadcast-txid"', async () => {
    await expectNotImplemented(provider.broadcastTransaction('deadbeef'));
    expect(fetchCalled).toBe(false);
  });

  test('broadcastTransaction never resolves to a fabricated txid', async () => {
    const settled = await provider.broadcastTransaction('deadbeef').then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e })
    );
    expect(settled.ok).toBe(false);
  });

  test('getTransactionStatus throws NOT_IMPLEMENTED instead of reporting { confirmed: false }', async () => {
    await expectNotImplemented(provider.getTransactionStatus('a'.repeat(64)));
    expect(fetchCalled).toBe(false);
  });

  test('estimateFee throws NOT_IMPLEMENTED instead of returning a hardcoded rate', async () => {
    await expectNotImplemented(provider.estimateFee(1));
    await expectNotImplemented(provider.estimateFee());
    expect(fetchCalled).toBe(false);
  });

  test('createInscription throws NOT_IMPLEMENTED instead of fabricating insc-*/tx-* ids', async () => {
    await expectNotImplemented(provider.createInscription({
      data: Buffer.from('data'),
      contentType: 'text/plain',
      feeRate: 2
    }));
    expect(fetchCalled).toBe(false);
  });

  test('transferInscription throws NOT_IMPLEMENTED instead of fabricating a transfer tx', async () => {
    await expectNotImplemented(provider.transferInscription('inscId', 'bc1qaddress'));
    await expectNotImplemented(provider.transferInscription('inscId', 'bc1qaddress', { feeRate: 3 }));
    expect(fetchCalled).toBe(false);
  });

  test('read path getInscriptionsBySatoshi still works (not part of the stub hardening)', async () => {
    const id = 'a'.repeat(64) + 'i1'; // well-formed inscription id (provider filters malformed ids)
    (globalThis as Record<string, unknown>).fetch = async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ inscription_ids: [id] })).buffer
    });
    const result = await provider.getInscriptionsBySatoshi('123');
    expect(result).toEqual([{ inscriptionId: id }]);
  });
});

describe('createOrdinalsProviderFromEnv with USE_LIVE_ORD_PROVIDER=true (#318)', () => {
  const savedUseLive = process.env.USE_LIVE_ORD_PROVIDER;
  const savedBaseUrl = process.env.ORD_PROVIDER_BASE_URL;
  const savedQuickNode = process.env.QUICKNODE_ENDPOINT;

  beforeEach(() => {
    // QuickNode takes precedence over the live HTTP provider; clear it so these
    // tests exercise the USE_LIVE_ORD_PROVIDER branch deterministically.
    delete process.env.QUICKNODE_ENDPOINT;
  });

  afterEach(() => {
    if (savedUseLive === undefined) delete process.env.USE_LIVE_ORD_PROVIDER;
    else process.env.USE_LIVE_ORD_PROVIDER = savedUseLive;
    if (savedBaseUrl === undefined) delete process.env.ORD_PROVIDER_BASE_URL;
    else process.env.ORD_PROVIDER_BASE_URL = savedBaseUrl;
    if (savedQuickNode === undefined) delete process.env.QUICKNODE_ENDPOINT;
    else process.env.QUICKNODE_ENDPOINT = savedQuickNode;
  });

  test('live provider broadcast throws rather than returning a fake txid', async () => {
    process.env.USE_LIVE_ORD_PROVIDER = 'true';
    process.env.ORD_PROVIDER_BASE_URL = 'http://ord.live.example';

    const provider = await createOrdinalsProviderFromEnv();
    expect(provider).toBeInstanceOf(OrdHttpProvider);

    let caught: unknown;
    try {
      await provider.broadcastTransaction('deadbeef');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructuredError);
    expect((caught as StructuredError).code).toMatch(/NOT_IMPLEMENTED$/);
  });

  test('live provider createInscription and transferInscription also throw', async () => {
    process.env.USE_LIVE_ORD_PROVIDER = 'true';
    process.env.ORD_PROVIDER_BASE_URL = 'http://ord.live.example';

    const provider = await createOrdinalsProviderFromEnv();
    await expect(provider.createInscription({ data: Buffer.from('x'), contentType: 'text/plain' }))
      .rejects.toThrow(/not implemented/i);
    await expect(provider.transferInscription('insc', 'bc1qaddr'))
      .rejects.toThrow(/not implemented/i);
  });

  test('mock provider is still returned when the live flag is off', async () => {
    delete process.env.USE_LIVE_ORD_PROVIDER;
    const provider = await createOrdinalsProviderFromEnv();
    expect(provider).not.toBeInstanceOf(OrdHttpProvider);
    // The mock is allowed to simulate inscriptions — that is its entire job.
    const created = await provider.createInscription({ data: Buffer.from('x'), contentType: 'text/plain' });
    expect(created.inscriptionId).toBeTruthy();
  });

  // Regression for #328: enabling the live provider without a real base URL used
  // to silently fall back to the placeholder https://ord.example.com/api, aiming
  // every read at a nonexistent host. It must now fail fast at construction.
  test('throws when ORD_PROVIDER_BASE_URL is unset', async () => {
    process.env.USE_LIVE_ORD_PROVIDER = 'true';
    delete process.env.ORD_PROVIDER_BASE_URL;

    let caught: unknown;
    try {
      await createOrdinalsProviderFromEnv();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructuredError);
    expect((caught as StructuredError).code).toBe('ORD_PROVIDER_BASE_URL_REQUIRED');
  });

  test('throws when ORD_PROVIDER_BASE_URL is blank/whitespace', async () => {
    process.env.USE_LIVE_ORD_PROVIDER = 'true';
    process.env.ORD_PROVIDER_BASE_URL = '   ';

    await expect(createOrdinalsProviderFromEnv()).rejects.toThrow(/ORD_PROVIDER_BASE_URL/);
  });

  test('throws when ORD_PROVIDER_BASE_URL is left at the documentation placeholder', async () => {
    process.env.USE_LIVE_ORD_PROVIDER = 'true';
    process.env.ORD_PROVIDER_BASE_URL = 'https://ord.example.com/api';

    let caught: unknown;
    try {
      await createOrdinalsProviderFromEnv();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructuredError);
    expect((caught as StructuredError).code).toBe('ORD_PROVIDER_BASE_URL_REQUIRED');
  });

  test('builds an OrdHttpProvider when a real base URL is supplied', async () => {
    process.env.USE_LIVE_ORD_PROVIDER = 'true';
    process.env.ORD_PROVIDER_BASE_URL = 'https://ord.live.example';

    const provider = await createOrdinalsProviderFromEnv();
    expect(provider).toBeInstanceOf(OrdHttpProvider);
  });
});
