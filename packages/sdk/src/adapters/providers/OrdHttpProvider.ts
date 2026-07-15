/* istanbul ignore file */
import type { OrdinalsProvider, InscriptionParts } from '../types.js';
import { StructuredError } from '../../utils/telemetry.js';
import { decode as decodeCbor } from '../../utils/cbor.js';
import { hexToBytes } from '../../utils/encoding.js';

interface HttpProviderOptions {
  baseUrl: string;
  /** Max bytes accepted for a JSON indexer response (default 1 MiB). */
  maxJsonBytes?: number;
  /** Max bytes accepted for fetched inscription content (default 5 MiB). */
  maxContentBytes?: number;
}

const DEFAULT_MAX_JSON_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 5 * 1024 * 1024;

/**
 * Documentation placeholder — never a reachable host. createOrdinalsProviderFromEnv
 * refuses to build a live provider pointed at it (issue #328).
 */
const PLACEHOLDER_ORD_BASE_URL = 'https://ord.example.com/api';

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

    // #407 phase 3: decode the inscription's CBOR metadata (`{ didDocument,
    // celLog | events }`) so a real chain can be reconstructed. Fetched AFTER the
    // content (so the content SSRF/size guards run first). Absent metadata is fine
    // (undefined) — the resolver fails closed when an anchoring inscription lacks
    // provenance metadata; an explicit inline `metadata` field that fails to decode
    // is a hard error (present-but-undecodable).
    const metadata = await this.fetchMetadata(id, data);

    return {
      inscriptionId: data.inscription_id || id,
      content: buf,
      contentType,
      txid,
      vout,
      satoshi: String(data.sat ?? ''),
      blockHeight: data.block_height,
      ...(metadata !== undefined ? { metadata } : {})
    };
  }

  /**
   * Fetch + CBOR-decode an inscription's metadata (#407 phase 3). Prefers an
   * inline hex `metadata` field on the indexer JSON, else the ord recursive
   * endpoint `/r/metadata/<id>` (same-origin, capped). Returns `undefined` when
   * no metadata exists (a 404 / absent field). Throws a clear fail-closed error
   * when metadata bytes are PRESENT but cannot be hex/CBOR decoded — a provider
   * that cannot read present metadata must not silently drop provenance.
   */
  private async fetchMetadata(id: string, indexerJson: any): Promise<Record<string, unknown> | undefined> {
    // An INLINE hex `metadata` field is an EXPLICIT provenance declaration:
    // present-but-undecodable is a hard fail-closed error.
    if (typeof indexerJson?.metadata === 'string' && indexerJson.metadata.length > 0) {
      try {
        return decodeCbor<Record<string, unknown>>(hexToBytes(indexerJson.metadata));
      } catch (e) {
        throw new StructuredError(
          'ORD_METADATA_UNDECODABLE',
          `OrdHttpProvider: inscription ${id} carries an inline metadata field that could not be hex/CBOR decoded (${e instanceof Error ? e.message : String(e)}); refusing to reconstruct from partial provenance`,
          { inscriptionId: id }
        );
      }
    }
    // The ord recursive `/r/metadata/<id>` route serves hex CBOR ONLY when
    // metadata exists. Distinguish the status EXPLICITLY (Greptile): ONLY a 404
    // (genuinely no metadata) or an empty body degrades to undefined; a 5xx /
    // other transient fault must THROW — swallowing it would let a flaky endpoint
    // drop a real anchoring inscription and silently truncate the chain tail
    // (I2). A present non-empty body that does not hex/CBOR decode is likewise a
    // hard fail-closed error. Direct fetch so the status code is visible
    // (fetchBytesWithLimit collapses every non-ok to null).
    const url = buildUrl(this.baseUrl, `/r/metadata/${id}`);
    const res = await (globalThis as any).fetch(url, { redirect: 'error', headers: { 'Accept': 'application/json' } });
    if (res.status === 404) return undefined; // genuinely no metadata on this inscription
    if (!res.ok) {
      throw new StructuredError(
        'ORD_METADATA_UNAVAILABLE',
        `OrdHttpProvider: inscription ${id} /r/metadata returned HTTP ${res.status}; refusing to reconstruct from possibly-incomplete provenance`,
        { inscriptionId: id }
      );
    }
    const lenHeader = res.headers?.get?.('content-length');
    if (lenHeader && Number(lenHeader) > this.maxJsonBytes) {
      throw new Error(`OrdHttpProvider: /r/metadata response exceeds ${this.maxJsonBytes} bytes (Content-Length ${lenHeader})`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > this.maxJsonBytes) {
      throw new Error(`OrdHttpProvider: /r/metadata response body exceeds ${this.maxJsonBytes} bytes`);
    }
    let text = new TextDecoder().decode(bytes).trim();
    if (text.length === 0) return undefined;
    if (text.startsWith('"') && text.endsWith('"')) {
      try { text = JSON.parse(text) as string; } catch { /* keep raw */ }
    }
    try {
      return decodeCbor<Record<string, unknown>>(hexToBytes(text));
    } catch (e) {
      throw new StructuredError(
        'ORD_METADATA_UNDECODABLE',
        `OrdHttpProvider: inscription ${id} /r/metadata response is present but could not be hex/CBOR decoded (${e instanceof Error ? e.message : String(e)}); refusing to reconstruct from partial provenance`,
        { inscriptionId: id }
      );
    }
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

  createInscription(params: {
    data?: Buffer;
    buildContent?: (satoshi: string) => InscriptionParts | Promise<InscriptionParts>;
    contentType: string;
    feeRate?: number;
    metadata?: Record<string, unknown>;
    targetSatoshi?: string;
  }): Promise<{
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
    metadata?: Record<string, unknown>;
  }> {
    if (params.buildContent || params.targetSatoshi) {
      return Promise.reject(new StructuredError(
        'ORD_PROVIDER_UNSUPPORTED',
        'This provider does not support deferred content (buildContent) or sat-targeted reinscription (targetSatoshi). Build the inscription locally and submit via broadcastTransaction.'
      ));
    }
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
    // USE_LIVE_ORD_PROVIDER opts into real network I/O, so the base URL must
    // point at a real ord server. Previously this silently defaulted to the
    // placeholder https://ord.example.com/api when ORD_PROVIDER_BASE_URL was
    // unset — quietly aiming every read at a nonexistent host and risking
    // failures/garbage being written into provenance. Fail fast instead so
    // misconfiguration surfaces at startup rather than mid-lifecycle (#328).
    const baseUrl = String(((globalThis as any).process?.env?.ORD_PROVIDER_BASE_URL) || '').trim();
    if (!baseUrl || baseUrl === PLACEHOLDER_ORD_BASE_URL) {
      const reason = !baseUrl
        ? 'it is not set or is blank'
        : `it is left at the documentation placeholder ${PLACEHOLDER_ORD_BASE_URL}`;
      throw new StructuredError(
        'ORD_PROVIDER_BASE_URL_REQUIRED',
        'USE_LIVE_ORD_PROVIDER=true requires ORD_PROVIDER_BASE_URL to be set to a real ord ' +
        `server URL, but ${reason}.`
      );
    }
    return new OrdHttpProvider({ baseUrl });
  }
  const mod = await import('./OrdMockProvider.js');
  return new mod.OrdMockProvider();
}

