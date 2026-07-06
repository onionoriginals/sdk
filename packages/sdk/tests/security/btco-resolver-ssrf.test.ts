import { describe, test, expect, afterEach } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';
import { OrdinalsClientProviderAdapter } from '../../src/did/providers/OrdinalsClientProviderAdapter';

/**
 * SSRF in the bitcoinRpcUrl did:btco resolution path.
 *
 * OrdinalsClientProviderAdapter.resolveInscription trusted `info.content_url`
 * from the (untrusted) ord endpoint verbatim, and DIDManager constructed
 * BtcoDidResolver without a fetchFn — so the resolver fetched whatever URL
 * the ord server returned via global fetch (any scheme/host, redirects
 * followed): e.g. http://169.254.169.254/ cloud metadata.
 *
 * Mirrors the #265 hardening already applied to OrdHttpProvider and the
 * fail-closed fetchContent of OrdinalsProviderResolverAdapter.
 */

const BASE = 'http://ord.internal:8080';
const realFetch = (globalThis as any).fetch;

function installFetch(handler: (url: string, init?: any) => Promise<any>) {
  (globalThis as any).fetch = (url: any, init?: any) => handler(String(url), init);
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function textResponse(body: string) {
  return { ok: true, status: 200, statusText: 'OK', async text() { return body; } };
}

afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

describe('OrdinalsClientProviderAdapter content_url origin pinning', () => {
  test('resolveInscription refuses an off-origin content_url (cloud metadata IP)', async () => {
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({
          inscription_id: 'abc', sat: 1, content_type: 'text/plain',
          content_url: 'http://169.254.169.254/latest/meta-data/iam/'
        });
      }
      return textResponse('x');
    });
    const client = new OrdinalsClient(BASE, 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, BASE);
    await expect(adapter.resolveInscription('abc')).rejects.toThrow(/Failed to resolve inscription/);
  });

  test('resolveInscription refuses a non-http(s) content_url', async () => {
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({
          inscription_id: 'abc', sat: 1, content_type: 'text/plain',
          content_url: 'file:///etc/passwd'
        });
      }
      return textResponse('x');
    });
    const client = new OrdinalsClient(BASE, 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, BASE);
    await expect(adapter.resolveInscription('abc')).rejects.toThrow(/Failed to resolve inscription/);
  });

  test('resolveInscription accepts a same-origin content_url and defaults relative/missing ones', async () => {
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({ inscription_id: 'abc', sat: 1, content_type: 'text/plain' });
      }
      return textResponse('x');
    });
    const client = new OrdinalsClient(BASE, 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, BASE);
    const info = await adapter.resolveInscription('abc');
    expect(info.content_url).toBe(`${BASE}/content/abc`);
  });

  test('fetchContent fails closed on off-origin URLs and never fetches them', async () => {
    const fetched: string[] = [];
    installFetch(async (url) => { fetched.push(url); return textResponse('x'); });
    const client = new OrdinalsClient(BASE, 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, BASE);

    const res = await adapter.fetchContent('http://169.254.169.254/latest/meta-data/');
    expect(res.ok).toBe(false);
    expect(fetched.length).toBe(0);
  });

  test('fetchContent fetches same-origin URLs without following redirects', async () => {
    const inits: any[] = [];
    installFetch(async (url, init) => { inits.push({ url, init }); return textResponse('content'); });
    const client = new OrdinalsClient(BASE, 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, BASE);

    const res = await adapter.fetchContent(`${BASE}/content/abc`);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('content');
    expect(inits.length).toBe(1);
    // redirect: 'error' closes the redirect-bypass hole in the origin pin.
    expect(inits[0].init?.redirect).toBe('error');
  });
});

describe('OrdinalsClientProviderAdapter same-origin RELATIVE content_url canonicalization', () => {
  test('resolveInscription resolves a relative same-origin content_url to an absolute URL that fetchContent accepts', async () => {
    const fetched: string[] = [];
    installFetch(async (url) => {
      fetched.push(url);
      if (url.includes('/inscription/')) {
        return jsonResponse({
          inscription_id: 'i1', sat: 1, content_type: 'text/plain',
          // Valid, same-origin, but RELATIVE — ord servers commonly return this
          // form. It must be stored resolved against baseUrl, because Node/Bun
          // fetch() rejects relative URLs outright.
          content_url: '/content/i1'
        });
      }
      return textResponse('content');
    });
    const client = new OrdinalsClient(BASE, 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, BASE);

    const info = await adapter.resolveInscription('i1');
    expect(info.content_url).toBe(`${BASE}/content/i1`);

    const res = await adapter.fetchContent(info.content_url);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('content');
    // The content request went to the absolute same-origin URL.
    expect(fetched).toContain(`${BASE}/content/i1`);
  });

  test('fetchContent canonicalizes a relative same-origin URL before fetching (never passes a relative URL to fetch)', async () => {
    const fetched: string[] = [];
    installFetch(async (url) => { fetched.push(url); return textResponse('content'); });
    const client = new OrdinalsClient(BASE, 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client as any, BASE);

    const res = await adapter.fetchContent('/content/i1');
    expect(res.ok).toBe(true);
    expect(fetched).toEqual([`${BASE}/content/i1`]);
  });

  test('end to end: a relative same-origin content_url still resolves the DID document (no unresolvable)', async () => {
    const fetched: string[] = [];
    const didDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:btco:123456'
    };
    installFetch(async (url) => {
      fetched.push(url);
      if (url === `${BASE}/sat/123456`) {
        return jsonResponse({ inscription_ids: ['i1'] });
      }
      if (url === `${BASE}/inscription/i1`) {
        return jsonResponse({
          inscription_id: 'i1', sat: 123456, content_type: 'application/json',
          content_url: '/content/i1'
        });
      }
      if (url === `${BASE}/content/i1`) {
        return textResponse(JSON.stringify(didDoc));
      }
      return { ok: false, status: 404, statusText: 'Not Found', async text() { return ''; }, async json() { return {}; } };
    });

    const sdk = OriginalsSDK.create({ network: 'mainnet', bitcoinRpcUrl: BASE });
    const resolved = await sdk.did.resolveDID('did:btco:123456');

    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe('did:btco:123456');
    // Every request the resolver made was an absolute same-origin URL.
    expect(fetched.every((u) => u.startsWith(`${BASE}/`))).toBe(true);
  });
});

describe('DIDManager bitcoinRpcUrl resolution path (end to end)', () => {
  test('a hostile content_url from the ord server is never fetched during resolveDID', async () => {
    const fetched: string[] = [];
    installFetch(async (url) => {
      fetched.push(url);
      if (url === `${BASE}/sat/123456`) {
        return jsonResponse({ inscription_ids: ['i1'] });
      }
      if (url === `${BASE}/inscription/i1`) {
        return jsonResponse({
          inscription_id: 'i1', sat: 123456, content_type: 'text/plain',
          content_url: 'http://169.254.169.254/latest/meta-data/'
        });
      }
      if (url === `${BASE}/content/i1`) {
        return textResponse('BTCO DID: did:btco:123456');
      }
      return { ok: false, status: 404, statusText: 'Not Found', async text() { return ''; }, async json() { return {}; } };
    });

    const sdk = OriginalsSDK.create({ network: 'mainnet', bitcoinRpcUrl: BASE });
    await sdk.did.resolveDID('did:btco:123456');

    // The internal address must never have been requested.
    expect(fetched.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });
});
