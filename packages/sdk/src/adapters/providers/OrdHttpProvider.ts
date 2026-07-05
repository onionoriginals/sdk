/* istanbul ignore file */
import type { OrdinalsProvider } from '../types.js';

interface HttpProviderOptions {
  baseUrl: string;
  /** Max bytes accepted for a JSON indexer response (default 1 MiB). */
  maxJsonBytes?: number;
  /** Max bytes accepted for fetched inscription content (default 5 MiB). */
  maxContentBytes?: number;
}

const DEFAULT_MAX_JSON_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 5 * 1024 * 1024;

function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Reject a candidate URL whose origin differs from baseUrl's. The indexer's
 * JSON is attacker-controllable (a compromised/malicious ord endpoint), so a
 * `content_url` it returns must never be followed to an arbitrary host — that
 * is a Server-Side Request Forgery vector (e.g. http://169.254.169.254/… cloud
 * metadata). Relative URLs resolve against baseUrl and stay same-origin.
 */
function assertSameOrigin(candidate: string, baseUrl: string): void {
  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(candidate, baseUrl).origin;
  } catch {
    throw new Error(`OrdHttpProvider: malformed content_url '${candidate}'`);
  }
  if (candidateOrigin !== new URL(baseUrl).origin) {
    throw new Error(
      `OrdHttpProvider: refusing to fetch content_url from origin ${candidateOrigin}, ` +
      `which differs from baseUrl origin ${new URL(baseUrl).origin} (possible SSRF)`
    );
  }
}

/**
 * Fetch a body while enforcing a hard byte cap — first via the Content-Length
 * header (cheap early reject) and again on the materialized bytes (a lying or
 * absent header can't smuggle an oversized/streamed body past the cap).
 */
async function fetchBytesWithLimit(url: string, maxBytes: number, init?: Record<string, unknown>): Promise<{ ok: boolean; bytes: Uint8Array } | null> {
  // redirect: 'error' closes the redirect-bypass hole in the origin pin: without
  // it, a same-origin content_url that HTTP-redirects to an internal host would
  // be followed past assertSameOrigin (which only checks the first hop).
  const res = await (globalThis as any).fetch(url, { redirect: 'error', ...(init ?? {}) });
  if (!res.ok) return null;
  const lenHeader = res.headers?.get?.('content-length');
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw new Error(`OrdHttpProvider: response exceeds ${maxBytes} bytes (Content-Length ${lenHeader})`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`OrdHttpProvider: response body exceeds ${maxBytes} bytes`);
  }
  return { ok: res.ok, bytes };
}

async function fetchJson<T>(url: string, maxBytes: number = DEFAULT_MAX_JSON_BYTES): Promise<T | null> {
  const res = await (globalThis as any).fetch(url, {
    headers: {
      'Accept': 'application/json'
    },
    // Do not follow redirects to another host (SSRF via redirect).
    redirect: 'error'
  });
  if (!res.ok) return null;
  // Reject an over-cap response up front via Content-Length. (The JSON body is
  // then parsed with the standard res.json(); the stronger materialized-bytes
  // cap is applied to the separate — attacker-influenced — content fetch.)
  const lenHeader = res.headers?.get?.('content-length');
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw new Error(`OrdHttpProvider: JSON response exceeds ${maxBytes} bytes (Content-Length ${lenHeader})`);
  }
  return (await res.json()) as T;
}

export class OrdHttpProvider implements OrdinalsProvider {
  private readonly baseUrl: string;
  private readonly maxJsonBytes: number;
  private readonly maxContentBytes: number;

  constructor(options: HttpProviderOptions) {
    if (!options?.baseUrl) {
      throw new Error('OrdHttpProvider requires baseUrl');
    }
    this.baseUrl = options.baseUrl;
    this.maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
    this.maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  }

  async getInscriptionById(id: string) {
    if (!id) return null;
    const data = await fetchJson<any>(buildUrl(this.baseUrl, `/inscription/${id}`), this.maxJsonBytes);
    if (!data) return null;
    // Expecting a shape similar to Ordinals indexers; adapt minimally
    const ownerOutput: string | undefined = data.owner_output;
    let txid = data.txid || 'unknown';
    let vout = typeof data.vout === 'number' ? data.vout : 0;
    if (ownerOutput && ownerOutput.includes(':')) {
      const [tid, v] = ownerOutput.split(':');
      txid = tid;
      vout = Number(v) || 0;
    }

    const contentType = data.content_type || 'application/octet-stream';
    // The content URL may come from the (untrusted) indexer response. Pin it to
    // baseUrl's origin before fetching so a malicious endpoint cannot redirect
    // us to an internal host (SSRF), and cap the downloaded size.
    const contentUrl = data.content_url || buildUrl(this.baseUrl, `/content/${id}`);
    assertSameOrigin(contentUrl, this.baseUrl);
    const content = await fetchBytesWithLimit(contentUrl, this.maxContentBytes);
    if (!content) return null;
    const buf = (globalThis as any).Buffer
      ? (globalThis as any).Buffer.from(content.bytes)
      : content.bytes as any;

    return {
      inscriptionId: data.inscription_id || id,
      content: buf,
      contentType,
      txid,
      vout,
      satoshi: String(data.sat ?? ''),
      blockHeight: data.block_height
    };
  }

  async getInscriptionsBySatoshi(satoshi: string) {
    if (!satoshi) return [];
    const data = await fetchJson<any>(buildUrl(this.baseUrl, `/sat/${satoshi}`));
    const ids: string[] = Array.isArray(data?.inscription_ids) ? data.inscription_ids : [];
    return ids.map((inscriptionId) => ({ inscriptionId }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async broadcastTransaction(_txHexOrObj: unknown): Promise<string> {
    // For example purposes only, return a placeholder
    return 'broadcast-txid';
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getTransactionStatus(_txid: string) {
    return { confirmed: false };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async estimateFee(blocks: number = 1): Promise<number> {
    // Basic fallback: some providers expose fee estimates; for example purposes, return linear estimate
    return 5 * Math.max(1, blocks);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createInscription(params: { data: any; contentType: string; feeRate?: number; }) {
    // Example placeholder: a real implementation would POST to a service
    // Here we return a deterministic mock-like result to avoid network coupling in code
    const inscriptionId = `insc-${Math.random().toString(36).slice(2)}`;
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
    return {
      inscriptionId,
      revealTxId: txid,
      txid,
      vout: 0,
      blockHeight: undefined,
      content: params.data,
      contentType: params.contentType,
      feeRate: params.feeRate
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async transferInscription(inscriptionId: string, _toAddress: string, _options?: { feeRate?: number }) {
    if (!inscriptionId) throw new Error('inscriptionId required');
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
    return {
      txid,
      vin: [{ txid: 'prev', vout: 0 }],
      vout: [{ value: 546, scriptPubKey: 'script' }],
      fee: 100,
      confirmations: 0
    };
  }
}

export async function createOrdinalsProviderFromEnv(): Promise<OrdinalsProvider> {
  const useLive = String(((globalThis as any).process?.env?.USE_LIVE_ORD_PROVIDER) || '').toLowerCase() === 'true';
  if (useLive) {
    const baseUrl = ((globalThis as any).process?.env?.ORD_PROVIDER_BASE_URL) || 'https://ord.example.com/api';
    return new OrdHttpProvider({ baseUrl });
  }
  const mod = await import('./OrdMockProvider.js');
  return new mod.OrdMockProvider();
}

