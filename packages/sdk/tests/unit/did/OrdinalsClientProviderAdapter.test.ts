/** Canonical test aggregator created by combine-tests script. */

/** Inlined from OrdinalsClientProviderAdapter.branches.part.ts */
import { describe, test, expect } from 'bun:test';
import { OrdinalsClient } from '../../../src/bitcoin/OrdinalsClient';
import { OrdinalsClientProviderAdapter } from '../../../src/did/providers/OrdinalsClientProviderAdapter';

describe('OrdinalsClientProviderAdapter branches', () => {
  test('throws when baseUrl is empty in resolveInscription', async () => {
    const client = new OrdinalsClient('http://example.com', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, '');
    await expect(adapter.resolveInscription('abc')).rejects.toThrow('requires a baseUrl');
  });

  test('handles non-ok response from fetch', async () => {
    const client = new OrdinalsClient('http://example.com', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, 'http://api');
    const originalFetch = global.fetch as any;
    (global as any).fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(adapter.resolveInscription('abc')).rejects.toThrow('Failed to resolve inscription');
    (global as any).fetch = originalFetch;
  });

  test('maps missing fields from JSON with fallbacks', async () => {
    const client = new OrdinalsClient('http://example.com', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, 'http://api/');
    const originalFetch = global.fetch as any;
    (global as any).fetch = async () => ({ ok: true, json: async () => ({}) });
    const info = await adapter.resolveInscription('abc');
    expect(info.content_type).toBe('text/plain');
    expect(info.content_url).toBe('http://api/content/abc');
    expect(typeof info.sat).toBe('number');
    (global as any).fetch = originalFetch;
  });

  test('maps sat number without coercion path', async () => {
    const client = new OrdinalsClient('http://example.com', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, 'http://api');
    const originalFetch = global.fetch as any;
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ inscription_id: 'abc', sat: 42, content_type: 'text/plain', content_url: 'http://api/content/abc' }) });
    const info = await adapter.resolveInscription('abc');
    expect(info.sat).toBe(42);
    (global as any).fetch = originalFetch;
  });
});

// The config.ordinalsProvider → resolver adapter (the path DIDManager uses when
// an ordinalsProvider is configured) must pass the optional getSatOwnership
// lookup straight through, and report none when the provider lacks it.
describe('OrdinalsProviderResolverAdapter getSatOwnership contract', () => {
  test('passes sat ownership through from the underlying provider', async () => {
    const { OrdinalsProviderResolverAdapter } = await import('../../../src/did/providers/OrdinalsProviderResolverAdapter');
    const owner = { address: 'bcrt1qmockowner', outpoint: 'tx-abc:0' };
    const provider = { getSatOwnership: async (_sat: string) => owner } as any;
    const adapter = new OrdinalsProviderResolverAdapter(provider);
    expect(await adapter.getSatOwnership('123')).toEqual(owner);
  });

  test('reports null when the provider has no ownership lookup', async () => {
    const { OrdinalsProviderResolverAdapter } = await import('../../../src/did/providers/OrdinalsProviderResolverAdapter');
    const provider = {} as any;
    const adapter = new OrdinalsProviderResolverAdapter(provider);
    expect(await adapter.getSatOwnership('123')).toBeNull();
  });
});
