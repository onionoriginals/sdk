/**
 * Regression tests for issue #343: OrdinalsClient fetched indexer-supplied
 * content_url with no origin pin, redirect ban, timeout, or size cap. The
 * #322 hardening landed in OrdinalsClientProviderAdapter/OrdHttpProvider but
 * missed the client itself, which is reachable via SignetProvider.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';

const BASE = 'http://ord.internal:8080';
const realFetch = (globalThis as any).fetch;

function installFetch(handler: (url: string, init?: any) => Promise<any>) {
  (globalThis as any).fetch = (url: any, init?: any) => handler(String(url), init);
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() { return body; }
  };
}

function binResponse(bytes: Uint8Array, headers?: Record<string, string>) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers?.[name.toLowerCase()] ?? null },
    async arrayBuffer() { return bytes.buffer; }
  };
}

afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

describe('OrdinalsClient content_url origin pinning (issue #343)', () => {
  test('resolveInscription refuses an off-origin content_url (cloud metadata IP) and never fetches it', async () => {
    const fetched: string[] = [];
    installFetch(async (url) => {
      fetched.push(url);
      if (url.includes('/inscription/')) {
        return jsonResponse({
          inscription_id: 'abc', sat: 1, content_type: 'text/plain',
          content_url: 'http://169.254.169.254/latest/meta-data/iam/'
        });
      }
      return binResponse(new Uint8Array([1]));
    });
    const client = new OrdinalsClient(BASE, 'mainnet');
    await expect(client.resolveInscription('abc')).rejects.toThrow(/possible SSRF/);
    expect(fetched.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });

  test('resolveInscription refuses a non-http(s) content_url scheme', async () => {
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({
          inscription_id: 'abc', sat: 1, content_type: 'text/plain',
          content_url: 'file:///etc/passwd'
        });
      }
      return binResponse(new Uint8Array([1]));
    });
    const client = new OrdinalsClient(BASE, 'mainnet');
    await expect(client.resolveInscription('abc')).rejects.toThrow(/possible SSRF|non-http/);
  });

  test('resolveInscription resolves a same-origin RELATIVE content_url against the endpoint', async () => {
    const fetched: string[] = [];
    installFetch(async (url) => {
      fetched.push(url);
      if (url.includes('/inscription/')) {
        return jsonResponse({
          inscription_id: 'i1', sat: 1, content_type: 'text/plain',
          content_url: '/content/i1'
        });
      }
      return binResponse(new Uint8Array([7, 7]));
    });
    const client = new OrdinalsClient(BASE, 'mainnet');
    const insc = await client.resolveInscription('i1');
    expect(insc?.content.length).toBe(2);
    expect(fetched).toContain(`${BASE}/content/i1`);
  });

  test('getInscriptionById path is protected too (delegates to resolveInscription)', async () => {
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({
          inscription_id: 'abc', sat: 1, content_type: 'text/plain',
          content_url: 'http://evil.example.com/content/abc'
        });
      }
      return binResponse(new Uint8Array([1]));
    });
    const client = new OrdinalsClient(BASE, 'signet');
    await expect(client.getInscriptionById('abc')).rejects.toThrow(/possible SSRF/);
  });

  test('every request is made with redirect: "error" and an abort signal', async () => {
    const inits: any[] = [];
    installFetch(async (url, init) => {
      inits.push(init);
      if (url.includes('/inscription/')) {
        return jsonResponse({ inscription_id: 'i1', sat: 1, content_type: 'text/plain' });
      }
      return binResponse(new Uint8Array([1]));
    });
    const client = new OrdinalsClient(BASE, 'mainnet');
    await client.resolveInscription('i1');
    expect(inits.length).toBeGreaterThanOrEqual(2); // JSON info + content
    for (const init of inits) {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeDefined();
    }
  });
});

describe('OrdinalsClient response size caps (issue #343)', () => {
  test('inscription content larger than maxContentBytes is rejected (materialized bytes)', async () => {
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({ inscription_id: 'i1', sat: 1, content_type: 'text/plain' });
      }
      return binResponse(new Uint8Array(64));
    });
    const client = new OrdinalsClient(BASE, 'mainnet', { maxContentBytes: 16 });
    await expect(client.resolveInscription('i1')).rejects.toThrow(/exceeds 16 bytes/);
  });

  test('a declared Content-Length above the cap is rejected before reading the body', async () => {
    let bodyRead = false;
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({ inscription_id: 'i1', sat: 1, content_type: 'text/plain' });
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? '999999999' : null) },
        async arrayBuffer() { bodyRead = true; return new Uint8Array(1).buffer; }
      };
    });
    const client = new OrdinalsClient(BASE, 'mainnet', { maxContentBytes: 1024 });
    await expect(client.resolveInscription('i1')).rejects.toThrow(/exceeds 1024 bytes/);
    expect(bodyRead).toBe(false);
  });

  test('oversized JSON responses are rejected when bytes are materializable', async () => {
    const big = new TextEncoder().encode(JSON.stringify({ inscription_ids: ['x'.repeat(4096)] }));
    installFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      async arrayBuffer() { return big.buffer; }
    }));
    const client = new OrdinalsClient(BASE, 'mainnet', { maxJsonBytes: 128 });
    await expect(client.getSatInfo('123')).rejects.toThrow(/exceeds 128 bytes/);
  });
});

describe('OrdinalsClient per-satoshi inscription cap (issue #343)', () => {
  test('a satoshi carrying more inscriptions than the cap fails loudly instead of downloading all content', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `insc-${i}`);
    const contentFetches: string[] = [];
    installFetch(async (url) => {
      if (url.includes('/sat/')) return jsonResponse({ inscription_ids: ids });
      if (url.includes('/inscription/')) {
        const id = url.split('/').pop();
        return jsonResponse({ inscription_id: id, sat: 1, content_type: 'text/plain' });
      }
      contentFetches.push(url);
      return binResponse(new Uint8Array([1]));
    });
    const client = new OrdinalsClient(BASE, 'mainnet', { maxInscriptionsPerSat: 3 });
    await expect(client.getInscriptionsBySatoshi('123')).rejects.toThrow(/ORD_TOO_MANY_INSCRIPTIONS|above the configured/);
    expect(contentFetches.length).toBe(0);
  });

  test('a satoshi within the cap still resolves every inscription', async () => {
    const ids = ['a', 'b', 'c'];
    installFetch(async (url) => {
      if (url.includes('/sat/')) return jsonResponse({ inscription_ids: ids });
      if (url.includes('/inscription/')) {
        const id = url.split('/').pop();
        return jsonResponse({ inscription_id: id, sat: 1, content_type: 'text/plain' });
      }
      return binResponse(new Uint8Array([1]));
    });
    const client = new OrdinalsClient(BASE, 'mainnet', { maxInscriptionsPerSat: 3 });
    const list = await client.getInscriptionsBySatoshi('123');
    expect(list.map((i) => i.inscriptionId)).toEqual(['a', 'b', 'c']);
  });
});
