/* istanbul ignore file */
import type { OrdinalsProvider } from '../types.js';
import { StructuredError } from '../../utils/telemetry.js';

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
  // Route through fetchBytesWithLimit so the cap holds even when the indexer
  // omits or understates Content-Length — the JSON response is as
  // attacker-controllable as the content fetch.
  const result = await fetchBytesWithLimit(url, maxBytes, {
    headers: {
      'Accept': 'application/json'
    }
  });
  if (!result) return null;
  return JSON.parse(new TextDecoder().decode(result.bytes)) as T;
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
    const data = await fetchJson<any>(buildUrl(this.baseUrl, `/sat/${satoshi}`), this.maxJsonBytes);
    const ids: string[] = Array.isArray(data?.inscription_ids) ? data.inscription_ids : [];
    return ids.map((inscriptionId) => ({ inscriptionId }));
  }

  // Transaction submission, status, fee estimation and inscription
  // creation/transfer are NOT implemented against a real ord endpoint yet.
  // These methods used to return fabricated success values (the literal
  // 'broadcast-txid', random insc-*/tx-* ids, a hardcoded fee, an invented
  // vin/vout/fee for transfers), which silently corrupted provenance for
  // anyone enabling USE_LIVE_ORD_PROVIDER=true. They now fail loudly,
  // mirroring the OrdinalsClient hardening (#248). Use a provider with real
  // broadcast support or an OrdinalsProvider backed by your own
  // infrastructure.

  broadcastTransaction(_txHexOrObj: unknown): Promise<string> {
    return Promise.reject(new StructuredError(
      'ORD_BROADCAST_NOT_IMPLEMENTED',
      'OrdHttpProvider.broadcastTransaction is not implemented: no transaction was broadcast. Configure an OrdinalsProvider with real broadcast support.'
    ));
  }

  getTransactionStatus(_txid: string): Promise<{ confirmed: boolean; blockHeight?: number; confirmations?: number }> {
    return Promise.reject(new StructuredError(
      'ORD_TX_STATUS_NOT_IMPLEMENTED',
      'OrdHttpProvider.getTransactionStatus is not implemented: transaction status cannot be determined. Configure an OrdinalsProvider with real status support.'
    ));
  }

  estimateFee(_blocks: number = 1): Promise<number> {
    return Promise.reject(new StructuredError(
      'ORD_FEE_ESTIMATE_NOT_IMPLEMENTED',
      'OrdHttpProvider.estimateFee is not implemented: refusing to return a hardcoded fee rate. Configure a FeeOracleAdapter or an OrdinalsProvider with real fee estimation.'
    ));
  }

  createInscription(_params: { data: Buffer; contentType: string; feeRate?: number; }): Promise<{
    inscriptionId: string;
    revealTxId: string;
    commitTxId?: string;
    satoshi?: string;
    txid?: string;
    vout?: number;
    blockHeight?: number;
    content?: Buffer;
    contentType?: string;
    feeRate?: number;
  }> {
    return Promise.reject(new StructuredError(
      'ORD_CREATE_INSCRIPTION_NOT_IMPLEMENTED',
      'OrdHttpProvider.createInscription is not implemented: no inscription was created and no transaction was broadcast. Configure an OrdinalsProvider with real inscription support.'
    ));
  }

  transferInscription(_inscriptionId: string, _toAddress: string, _options?: { feeRate?: number }): Promise<{
    txid: string;
    vin: Array<{ txid: string; vout: number }>;
    vout: Array<{ value: number; scriptPubKey: string; address?: string }>;
    fee: number;
    blockHeight?: number;
    confirmations?: number;
    satoshi?: string;
  }> {
    return Promise.reject(new StructuredError(
      'ORD_TRANSFER_NOT_IMPLEMENTED',
      'OrdHttpProvider.transferInscription is not implemented: no transfer was broadcast. Configure an OrdinalsProvider with real transfer support.'
    ));
  }
}

export async function createOrdinalsProviderFromEnv(
  options?: { network?: 'mainnet' | 'testnet' | 'signet' | 'regtest' }
): Promise<OrdinalsProvider> {
  // A configured QuickNode endpoint takes precedence: it is the only
  // env-selectable provider with real broadcast/status/fee support.
  const quickNodeEndpoint = ((globalThis as any).process?.env?.QUICKNODE_ENDPOINT) || '';
  if (quickNodeEndpoint) {
    const mod = await import('./QuickNodeProvider.js');
    // Pass the SDK's network through so the provider verifies the endpoint's
    // chain on first RPC use (issue #350). Falls back to BITCOIN_NETWORK; when
    // neither is set, no chain check is performed (unchanged behavior).
    const envNetworkRaw = String(((globalThis as any).process?.env?.BITCOIN_NETWORK) || '');
    const envNetwork = (['mainnet', 'testnet', 'signet', 'regtest'] as const).find((n) => n === envNetworkRaw);
    const expectedNetwork = options?.network ?? envNetwork;
    return new mod.QuickNodeProvider({ endpoint: quickNodeEndpoint, expectedNetwork });
  }
  const useLive = String(((globalThis as any).process?.env?.USE_LIVE_ORD_PROVIDER) || '').toLowerCase() === 'true';
  if (useLive) {
    const baseUrl = ((globalThis as any).process?.env?.ORD_PROVIDER_BASE_URL) || 'https://ord.example.com/api';
    return new OrdHttpProvider({ baseUrl });
  }
  const mod = await import('./OrdMockProvider.js');
  return new mod.OrdMockProvider();
}

