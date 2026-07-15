import { describe, test, expect, afterEach } from 'bun:test';
import { OrdHttpProvider } from '../../src/adapters/providers/OrdHttpProvider';

/**
 * #265: OrdHttpProvider follows a content_url taken from the (untrusted) indexer
 * response. A malicious/compromised ord endpoint can point content_url at an
 * internal address to make the client fetch it (SSRF), and can return an
 * unbounded body. These tests exercise the attack from the caller's side.
 */

const BASE = 'https://ord.example.com/api';
// Well-formed inscription id (`<64-hex>i<vout>`) — OrdHttpProvider now rejects
// malformed ids before any fetch, so these SSRF/size tests use a valid shape.
const ID = 'a'.repeat(64) + 'i0';
const realFetch = (globalThis as any).fetch;

function installFetch(handler: (url: string, init?: any) => Promise<any>) {
  (globalThis as any).fetch = (url: string, init?: any) => handler(String(url), init);
}

function jsonResponse(body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? String(text.length) : null) },
    async json() { return body; },
    async arrayBuffer() { return new TextEncoder().encode(text).buffer; },
    async text() { return text; }
  };
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    async arrayBuffer() { return new ArrayBuffer(0); },
    async text() { return ''; }
  };
}

function bytesResponse(bytes: Uint8Array, contentLength?: number) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? String(contentLength ?? bytes.byteLength) : null) },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  };
}

describe('OrdHttpProvider SSRF / size hardening (#265)', () => {
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  test('refuses to follow a content_url on a different origin than baseUrl', async () => {
    const fetched: string[] = [];
    installFetch(async (url) => {
      fetched.push(url);
      if (url.includes('/inscription/')) {
        // Attacker-controlled indexer points content at the cloud metadata IP.
        return jsonResponse({ content_url: 'http://169.254.169.254/latest/meta-data/iam/', content_type: 'text/plain' });
      }
      return bytesResponse(new Uint8Array([1, 2, 3]));
    });

    const provider = new OrdHttpProvider({ baseUrl: BASE });
    await expect(provider.getInscriptionById(ID)).rejects.toThrow(/SSRF|different|origin/i);

    // The internal address must never have been requested.
    expect(fetched.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });

  test('accepts a same-origin content_url', async () => {
    installFetch(async (url) => {
      if (url.includes('/r/metadata/')) return notFoundResponse(); // no CBOR metadata
      if (url.includes('/inscription/')) {
        return jsonResponse({ content_url: `${BASE}/content/abc`, content_type: 'text/plain', sat: '123' });
      }
      return bytesResponse(new Uint8Array([104, 105])); // "hi"
    });
    const provider = new OrdHttpProvider({ baseUrl: BASE });
    const res = await provider.getInscriptionById(ID);
    expect(res).not.toBeNull();
    expect(res!.contentType).toBe('text/plain');
  });

  test('does not follow redirects (closes the redirect-bypass SSRF hole)', async () => {
    const inits: any[] = [];
    installFetch(async (url, init) => {
      inits.push({ url, init });
      if (url.includes('/r/metadata/')) return notFoundResponse();
      if (url.includes('/inscription/')) {
        return jsonResponse({ content_url: `${BASE}/content/abc`, content_type: 'text/plain', sat: '123' });
      }
      return bytesResponse(new Uint8Array([1]));
    });
    const provider = new OrdHttpProvider({ baseUrl: BASE });
    await provider.getInscriptionById(ID);
    // Every fetch this provider makes must opt out of redirect-following so a
    // same-origin URL cannot 30x-redirect us to an internal host.
    expect(inits.length).toBeGreaterThan(0);
    expect(inits.every((c) => c.init?.redirect === 'error')).toBe(true);
  });

  test('a 5xx on /r/metadata fails closed (does not silently drop provenance — Greptile/I2)', async () => {
    installFetch(async (url) => {
      if (url.includes('/r/metadata/')) {
        return { ok: false, status: 503, headers: { get: () => null }, async arrayBuffer() { return new ArrayBuffer(0); } };
      }
      if (url.includes('/inscription/')) {
        return jsonResponse({ content_url: `${BASE}/content/abc`, content_type: 'text/plain', sat: '123' });
      }
      return bytesResponse(new Uint8Array([104, 105])); // "hi"
    });
    const provider = new OrdHttpProvider({ baseUrl: BASE });
    await expect(provider.getInscriptionById(ID)).rejects.toThrow(/ORD_METADATA_UNAVAILABLE|HTTP 503/);
  });

  test('a 404 on /r/metadata degrades to no metadata (not an error)', async () => {
    installFetch(async (url) => {
      if (url.includes('/r/metadata/')) return notFoundResponse();
      if (url.includes('/inscription/')) {
        return jsonResponse({ content_url: `${BASE}/content/abc`, content_type: 'text/plain', sat: '123' });
      }
      return bytesResponse(new Uint8Array([104, 105]));
    });
    const provider = new OrdHttpProvider({ baseUrl: BASE });
    const res = await provider.getInscriptionById(ID);
    expect(res).not.toBeNull();
    expect((res as any).metadata).toBeUndefined();
  });

  test('rejects an oversized content body (declared Content-Length)', async () => {
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({ content_type: 'application/octet-stream' });
      }
      // Small actual body, but a lying/huge Content-Length header.
      return bytesResponse(new Uint8Array([0]), 50 * 1024 * 1024);
    });
    const provider = new OrdHttpProvider({ baseUrl: BASE, maxContentBytes: 1024 });
    await expect(provider.getInscriptionById(ID)).rejects.toThrow(/exceeds .* bytes/);
  });

  test('rejects a malformed inscription id before any fetch (path-traversal guard — Greptile)', async () => {
    const fetched: string[] = [];
    installFetch(async (url) => { fetched.push(url); return jsonResponse({}); });
    const provider = new OrdHttpProvider({ baseUrl: BASE });
    // A compromised indexer id like `../../admin` must never reach a URL path.
    expect(await provider.getInscriptionById('../../admin')).toBeNull();
    expect(await provider.getInscriptionById('not-an-id')).toBeNull();
    expect(fetched.length).toBe(0);
  });

  test('getInscriptionsBySatoshi drops malformed ids from the indexer', async () => {
    installFetch(async (url) => {
      if (url.includes('/sat/')) return jsonResponse({ inscription_ids: [ID, '../../admin', 'garbage'] });
      return jsonResponse({});
    });
    const provider = new OrdHttpProvider({ baseUrl: BASE });
    const list = await provider.getInscriptionsBySatoshi('123');
    expect(list).toEqual([{ inscriptionId: ID }]);
  });

  test('rejects an oversized content body (actual bytes exceed cap with no header)', async () => {
    installFetch(async (url) => {
      if (url.includes('/inscription/')) {
        return jsonResponse({ content_type: 'application/octet-stream' });
      }
      const big = new Uint8Array(2048);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null }, // no Content-Length
        async arrayBuffer() { return big.buffer; }
      };
    });
    const provider = new OrdHttpProvider({ baseUrl: BASE, maxContentBytes: 1024 });
    await expect(provider.getInscriptionById(ID)).rejects.toThrow(/exceeds .* bytes/);
  });
});
