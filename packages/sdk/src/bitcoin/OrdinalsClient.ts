import { OrdinalsInscription, BitcoinTransaction } from '../types/index.js';
import { decode as decodeCbor } from '../utils/cbor.js';
import { hexToBytes } from '../utils/encoding.js';
import { StructuredError } from '../utils/telemetry.js';

/** Max bytes accepted for a JSON indexer response (default 1 MiB). */
const DEFAULT_MAX_JSON_BYTES = 1 * 1024 * 1024;
/** Max bytes accepted for fetched inscription content (default 5 MiB). */
const DEFAULT_MAX_CONTENT_BYTES = 5 * 1024 * 1024;
/** Per-request timeout (default 10 s). */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Max inscriptions resolved (content downloaded) per satoshi (default 100). */
const DEFAULT_MAX_INSCRIPTIONS_PER_SAT = 100;
/** Content downloads per batch when resolving a satoshi's inscriptions. */
const SAT_RESOLVE_BATCH_SIZE = 8;

export interface OrdinalsClientOptions {
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Max bytes accepted for a JSON indexer response. */
  maxJsonBytes?: number;
  /** Max bytes accepted for fetched inscription content. */
  maxContentBytes?: number;
  /** Max inscriptions resolved per satoshi before failing loudly. */
  maxInscriptionsPerSat?: number;
}

/**
 * Reject a candidate URL whose scheme is not http(s) or whose origin differs
 * from the configured endpoint's, and return its RESOLVED ABSOLUTE form. The
 * ord endpoint's JSON is attacker-controllable (a compromised/malicious
 * indexer), so a `content_url` it returns must never be followed to an
 * arbitrary host or scheme — that is a Server-Side Request Forgery vector
 * (e.g. http://169.254.169.254/… cloud metadata, file:///…). Relative URLs
 * resolve against the endpoint and stay same-origin. Mirrors the #265/#322
 * hardening in OrdHttpProvider and OrdinalsClientProviderAdapter, which
 * protected the adapter but left this client exposed on the SignetProvider
 * read path (issue #343).
 */
function resolveSameOrigin(candidate: string, baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate, baseUrl);
  } catch {
    throw new Error(`OrdinalsClient: malformed content_url '${candidate}'`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `OrdinalsClient: refusing non-http(s) content_url scheme '${parsed.protocol}' (possible SSRF)`
    );
  }
  const baseOrigin = new URL(baseUrl).origin;
  if (parsed.origin !== baseOrigin) {
    throw new Error(
      `OrdinalsClient: refusing to fetch content_url from origin ${parsed.origin}, ` +
      `which differs from the configured endpoint origin ${baseOrigin} (possible SSRF)`
    );
  }
  return parsed.toString();
}

/** Early reject via the Content-Length header when the server declares one. */
function assertContentLengthWithin(res: { headers?: { get?: (name: string) => string | null } }, maxBytes: number): void {
  const lenHeader = res.headers?.get?.('content-length');
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw new Error(`OrdinalsClient: response exceeds ${maxBytes} bytes (Content-Length ${lenHeader})`);
  }
}

export class OrdinalsClient {
  private readonly timeoutMs: number;
  private readonly maxJsonBytes: number;
  private readonly maxContentBytes: number;
  private readonly maxInscriptionsPerSat: number;

  constructor(
    private rpcUrl: string,
    private network: 'mainnet' | 'regtest' | 'signet',
    options: OrdinalsClientOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
    this.maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
    this.maxInscriptionsPerSat = options.maxInscriptionsPerSat ?? DEFAULT_MAX_INSCRIPTIONS_PER_SAT;
  }

  /**
   * Hardened fetch defaults: never follow a redirect (a same-origin URL must
   * not 30x resolution off the pinned origin) and bound the request time so a
   * stalling endpoint cannot hang resolution indefinitely.
   */
  private fetchInit(extra?: RequestInit): RequestInit {
    return {
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(extra ?? {})
    };
  }

  async getInscriptionById(id: string): Promise<OrdinalsInscription | null> {
    if (!id) return null;
    return this.resolveInscription(id);
  }

  async getInscriptionsBySatoshi(satoshi: string): Promise<OrdinalsInscription[]> {
    const info = await this.getSatInfo(satoshi);
    if (!info.inscription_ids.length) return [];
    // Resolving an inscription downloads its full content, so a heavily
    // reinscribed satoshi must not translate into unbounded downloads
    // (memory DoS — issue #343). Fail loudly above the cap rather than
    // silently truncating, which could hide the inscription a caller is
    // looking for; raise maxInscriptionsPerSat to opt into more.
    if (info.inscription_ids.length > this.maxInscriptionsPerSat) {
      throw new StructuredError(
        'ORD_TOO_MANY_INSCRIPTIONS',
        `Satoshi ${satoshi} carries ${info.inscription_ids.length} inscriptions, above the configured ` +
        `cap of ${this.maxInscriptionsPerSat}. Raise maxInscriptionsPerSat to resolve this satoshi.`
      );
    }
    // Bounded concurrency: download content in small batches instead of one
    // Promise.all over every inscription on the sat.
    const inscriptions: Array<OrdinalsInscription | null> = [];
    for (let i = 0; i < info.inscription_ids.length; i += SAT_RESOLVE_BATCH_SIZE) {
      const batch = info.inscription_ids.slice(i, i + SAT_RESOLVE_BATCH_SIZE);
      inscriptions.push(...await Promise.all(batch.map(id => this.resolveInscription(id))));
    }
    return inscriptions.filter((x): x is OrdinalsInscription => x !== null);
  }

  // Transaction submission and fee estimation are NOT implemented against a
  // real node yet. These methods used to return fabricated success values
  // (a fake txid, a hardcoded fee), which silently corrupted provenance for
  // anyone using this class as the "production" client. They now fail loudly.
  // Use a provider with real broadcast support (e.g. SignetProvider) or an
  // OrdinalsProvider implementation backed by your own infrastructure.

  broadcastTransaction(_tx: BitcoinTransaction): Promise<string> {
    return Promise.reject(new StructuredError(
      'ORD_BROADCAST_NOT_IMPLEMENTED',
      'OrdinalsClient.broadcastTransaction is not implemented: no transaction was broadcast. Configure an OrdinalsProvider with real broadcast support.'
    ));
  }

  getTransactionStatus(_txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  }> {
    return Promise.reject(new StructuredError(
      'ORD_TX_STATUS_NOT_IMPLEMENTED',
      'OrdinalsClient.getTransactionStatus is not implemented: transaction status cannot be determined. Configure an OrdinalsProvider with real status support.'
    ));
  }

  estimateFee(_blocks: number = 1): Promise<number> {
    return Promise.reject(new StructuredError(
      'ORD_FEE_ESTIMATE_NOT_IMPLEMENTED',
      'OrdinalsClient.estimateFee is not implemented: refusing to return a hardcoded fee rate. Configure a FeeOracleAdapter or an OrdinalsProvider with real fee estimation.'
    ));
  }

  // Added provider-like helper methods commonly expected by higher-level resolvers

  async getSatInfo(satoshi: string): Promise<{ inscription_ids: string[] }> {
    const data = await this.fetchJson<any>(`/sat/${satoshi}`);
    if (!data) return { inscription_ids: [] };
    // Support both {inscription_ids: []} and {data: {inscription_ids: []}} shapes via fetchJson
    const inscriptionIds = Array.isArray(data.inscription_ids) ? data.inscription_ids : [];
    return { inscription_ids: inscriptionIds };
  }

  async resolveInscription(identifier: string): Promise<OrdinalsInscription | null> {
    if (!identifier) return null;
    const info = await this.fetchJson<any>(`/inscription/${identifier}`);
    if (!info) return null;

    // Fetch content bytes. content_url comes from the (untrusted) indexer
    // response: pin it to the configured endpoint's origin before fetching
    // (SSRF guard), refuse redirects, bound the request time, and cap the
    // downloaded size.
    const contentUrl = resolveSameOrigin(
      String(info.content_url || `${this.rpcUrl}/content/${identifier}`),
      this.rpcUrl
    );
    const contentRes = await fetch(contentUrl, this.fetchInit());
    if (!contentRes.ok) throw new Error(`Failed to fetch inscription content: ${contentRes.status}`);
    assertContentLengthWithin(contentRes, this.maxContentBytes);
    const contentArrayBuf = await contentRes.arrayBuffer();
    if (contentArrayBuf.byteLength > this.maxContentBytes) {
      throw new Error(`OrdinalsClient: inscription content exceeds ${this.maxContentBytes} bytes`);
    }
    const content = Buffer.from(new Uint8Array(contentArrayBuf));

    // owner_output may be 'txid:vout'
    let txid = 'unknown';
    let vout = 0;
    if (typeof info.owner_output === 'string' && info.owner_output.includes(':')) {
      const [tid, v] = info.owner_output.split(':');
      txid = tid;
      vout = Number(v) || 0;
    }

    // sat number provided as number or string
    const satoshi = String(info.sat ?? '');

    const inscription: OrdinalsInscription = {
      satoshi,
      inscriptionId: info.inscription_id || identifier,
      content,
      contentType: info.content_type || 'application/octet-stream',
      txid,
      vout,
      blockHeight: info.block_height
    };

    return inscription;
  }

  async getMetadata(inscriptionId: string): Promise<Record<string, unknown> | null> {
    if (!inscriptionId) return null;
    const base = this.rpcUrl.replace(/\/$/, '');
    const res = await fetch(
      `${base}/r/metadata/${inscriptionId}`,
      this.fetchInit({ headers: { 'Accept': 'application/json' } })
    );
    if (!res.ok) {
      return null;
    }
    assertContentLengthWithin(res, this.maxJsonBytes);
    // Materialize bytes when possible so the cap counts BYTES: text.length
    // counts UTF-16 code units, so multi-byte content could consume up to 4x
    // the cap when a malicious indexer omits/understates Content-Length.
    let rawText: string;
    if (typeof (res as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > this.maxJsonBytes) {
        return null;
      }
      rawText = new TextDecoder().decode(bytes);
    } else {
      // Test doubles may implement only text(); the Content-Length check
      // above is the only cap available in that case.
      rawText = await res.text();
    }
    let text = rawText.trim();
    if (text.startsWith('"') && text.endsWith('"')) {
      try {
        text = JSON.parse(text);
      } catch (_) {
        // Keep original text if parsing fails
      }
    }
    try {
      const bytes = hexToBytes(text);
      return decodeCbor<Record<string, unknown>>(bytes);
    } catch (_) {
      return null;
    }
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    const url = `${this.rpcUrl.replace(/\/$/, '')}${path}`;
    // The JSON response is as attacker-controllable as the content fetch:
    // refuse redirects, bound the request time, and cap the accepted size.
    const res = await fetch(url, this.fetchInit({ headers: { 'Accept': 'application/json' } }));
    if (!res.ok) return null;
    assertContentLengthWithin(res, this.maxJsonBytes);
    let body: any;
    if (typeof (res as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
      // Materialize the bytes so the cap holds even when the server omits or
      // understates Content-Length.
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > this.maxJsonBytes) {
        throw new Error(`OrdinalsClient: JSON response exceeds ${this.maxJsonBytes} bytes`);
      }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } else {
      // Test doubles may implement only json(); the Content-Length check
      // above is the only cap available in that case.
      body = await res.json();
    }
    // Accept { data: T } or T
    return (body && typeof body === 'object' && 'data' in body) ? body.data : body;
  }
}

