import type { OrdinalsProvider } from '../types.js';
import { StructuredError } from '../../utils/telemetry.js';
import { validateSatoshiNumber } from '../../utils/satoshi-validation.js';

export interface QuickNodeProviderOptions {
  /**
   * Full QuickNode endpoint URL including the token path, e.g.
   * `https://your-endpoint-name.btc.quiknode.pro/<token>/`.
   * The endpoint must have the "Ordinals & Runes API" add-on enabled for
   * inscription reads (ord_* methods); standard Bitcoin Core RPC methods
   * (sendrawtransaction, getrawtransaction, estimatesmartfee) are served by
   * the same endpoint.
   */
  endpoint: string;
  /** Request timeout in milliseconds (default: 10000). */
  timeout?: number;
  /** Max bytes accepted for a JSON-RPC response body (default 1 MiB). */
  maxJsonBytes?: number;
  /** Max bytes accepted for decoded inscription content (default 5 MiB). */
  maxContentBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_JSON_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 5 * 1024 * 1024;

/** Bitcoin Core RPC error code for "No such mempool or blockchain transaction". */
const RPC_INVALID_ADDRESS_OR_KEY = -5;

interface JsonRpcError {
  code?: number;
  message?: string;
}

/**
 * The ord server's `/inscription/:id` JSON shape, which QuickNode's
 * Ordinals & Runes API returns as the JSON-RPC result of `ord_getInscription`.
 */
interface QuickNodeInscription {
  id?: string;
  inscription_id?: string;
  sat?: number | string | null;
  satpoint?: string;
  output?: string;
  content_type?: string;
  effective_content_type?: string;
  height?: number;
  genesis_height?: number;
  address?: string;
  value?: number;
}

/**
 * OrdinalsProvider backed by a QuickNode Bitcoin endpoint.
 *
 * Everything speaks JSON-RPC 2.0 against the single QuickNode endpoint URL:
 * - Inscription/sat reads use the Ordinals & Runes API add-on
 *   (`ord_getInscription`, `ord_getSat`, `ord_getContent`).
 * - Broadcast, status and fees use standard Bitcoin Core RPC
 *   (`sendrawtransaction`, `getrawtransaction`, `estimatesmartfee`).
 *
 * Write-path inscription construction (createInscription /
 * transferInscription) is intentionally NOT implemented: QuickNode is a
 * read/broadcast service and does not build or sign transactions. Those
 * methods fail loudly (mirroring the OrdinalsClient/OrdHttpProvider
 * hardening) rather than fabricating on-chain data. Build the commit/reveal
 * or transfer transaction locally and submit it via broadcastTransaction.
 */
export class QuickNodeProvider implements OrdinalsProvider {
  private readonly endpoint: string;
  private readonly timeout: number;
  private readonly maxJsonBytes: number;
  private readonly maxContentBytes: number;

  constructor(options: QuickNodeProviderOptions) {
    if (!options?.endpoint) {
      throw new StructuredError('QUICKNODE_ENDPOINT_REQUIRED', 'QuickNodeProvider requires an endpoint URL');
    }
    let parsed: URL;
    try {
      parsed = new URL(options.endpoint);
    } catch {
      throw new StructuredError('QUICKNODE_ENDPOINT_INVALID', `QuickNodeProvider endpoint is not a valid URL: ${options.endpoint}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new StructuredError('QUICKNODE_ENDPOINT_INVALID', `QuickNodeProvider endpoint must be http(s), got ${parsed.protocol}`);
    }
    this.endpoint = options.endpoint;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
    this.maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  }

  /**
   * POST a JSON-RPC 2.0 request to the QuickNode endpoint, enforcing the
   * timeout and a hard byte cap on the response — first via Content-Length
   * (cheap early reject) and again on the materialized bytes, so a lying or
   * absent header can't smuggle an oversized body past the cap.
   *
   * QuickNode (like bitcoind) may report RPC-level errors with a non-2xx
   * status but still send a JSON body; parse the body when possible so the
   * RPC error surfaces instead of an opaque HTTP failure.
   */
  private async rpcCall<T>(method: string, params: unknown[], maxBytes?: number): Promise<T> {
    const cap = maxBytes ?? this.maxJsonBytes;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeout),
    });
    const lenHeader = res.headers?.get?.('content-length');
    if (lenHeader && Number(lenHeader) > cap) {
      throw new StructuredError(
        'QUICKNODE_RESPONSE_TOO_LARGE',
        `QuickNodeProvider: ${method} response exceeds ${cap} bytes (Content-Length ${lenHeader})`
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > cap) {
      throw new StructuredError(
        'QUICKNODE_RESPONSE_TOO_LARGE',
        `QuickNodeProvider: ${method} response body exceeds ${cap} bytes`
      );
    }
    let data: { result?: T; error?: JsonRpcError | null };
    try {
      data = JSON.parse(new TextDecoder().decode(bytes)) as { result?: T; error?: JsonRpcError | null };
    } catch {
      throw new StructuredError(
        'QUICKNODE_RPC_HTTP_ERROR',
        `QuickNodeProvider: ${method} request failed: HTTP ${res.status} ${res.statusText}`
      );
    }
    if (data.error) {
      throw new StructuredError(
        'QUICKNODE_RPC_ERROR',
        `QuickNodeProvider: ${method} RPC error: ${data.error.message ?? JSON.stringify(data.error)}`,
        { rpcCode: data.error.code, rpcMessage: data.error.message, method }
      );
    }
    if (!res.ok) {
      throw new StructuredError(
        'QUICKNODE_RPC_HTTP_ERROR',
        `QuickNodeProvider: ${method} request failed: HTTP ${res.status} ${res.statusText}`
      );
    }
    return data.result as T;
  }

  /**
   * True for RPC failures that mean "this thing does not exist" rather than a
   * transport/config fault. Only Bitcoin Core's -5 code and ord-style
   * "<resource> not found" messages qualify; the match is anchored to the raw
   * RPC error message and to known resource nouns so infrastructure errors
   * that merely contain "not found" (e.g. "API key not found", "Endpoint not
   * found in routing table") propagate instead of masquerading as an empty
   * data source.
   */
  private static isNotFound(err: unknown): boolean {
    if (!(err instanceof StructuredError) || err.code !== 'QUICKNODE_RPC_ERROR') return false;
    if (err.details?.rpcCode === RPC_INVALID_ADDRESS_OR_KEY) return true;
    const rpcMessage = err.details?.rpcMessage;
    if (typeof rpcMessage !== 'string') return false;
    return /^(?:inscription|sat(?:oshi)?|output|content|transaction|tx)\b[^]*\bnot found\.?$/i.test(rpcMessage.trim());
  }

  /**
   * Decode the `ord_getContent` result into raw bytes. QuickNode returns the
   * inscription content base64-encoded inside the JSON-RPC result (either as
   * a bare string or wrapped in an object). Content that doesn't decode as
   * base64 is treated as literal UTF-8 text — some gateways return text
   * inscriptions unencoded.
   *
   * A short alphanumeric text inscription (e.g. "text") is shape-ambiguous:
   * it passes the base64 charset/length checks but is far more likely to be
   * the literal content. For text-typed inscriptions the base64 reading is
   * only trusted when the decoded bytes are themselves valid UTF-8 — literal
   * words almost never decode to valid UTF-8, while genuinely base64-encoded
   * text content always does. Binary content types are always base64.
   */
  private decodeContent(result: unknown, contentType?: string): Buffer {
    let raw: unknown = result;
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      raw = obj.content ?? obj.data ?? obj.base64 ?? null;
    }
    if (typeof raw !== 'string') {
      throw new StructuredError(
        'QUICKNODE_CONTENT_UNEXPECTED_SHAPE',
        'QuickNodeProvider: ord_getContent returned no decodable content'
      );
    }
    let buf: Buffer | undefined;
    const compact = raw.replace(/\s+/g, '');
    if (compact.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0) {
      const decoded = Buffer.from(compact, 'base64');
      if (!QuickNodeProvider.isTextContentType(contentType) || QuickNodeProvider.isValidUtf8(decoded)) {
        buf = decoded;
      }
    }
    buf ??= Buffer.from(raw, 'utf8');
    if (buf.byteLength > this.maxContentBytes) {
      throw new StructuredError(
        'QUICKNODE_CONTENT_TOO_LARGE',
        `QuickNodeProvider: inscription content exceeds ${this.maxContentBytes} bytes`
      );
    }
    return buf;
  }

  private static isTextContentType(contentType?: string): boolean {
    if (!contentType) return false;
    const mime = contentType.split(';')[0].trim().toLowerCase();
    return mime.startsWith('text/')
      || mime === 'application/json'
      || mime.endsWith('+json')
      || mime.endsWith('+xml')
      || mime === 'application/javascript'
      || mime === 'image/svg+xml';
  }

  private static isValidUtf8(bytes: Buffer): boolean {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  }

  async getInscriptionById(id: string) {
    if (!id) return null;
    let info: QuickNodeInscription | null;
    try {
      info = await this.rpcCall<QuickNodeInscription | null>('ord_getInscription', [id]);
    } catch (err) {
      if (QuickNodeProvider.isNotFound(err)) return null;
      throw err;
    }
    if (!info) return null;

    // Current location comes from the satpoint ('txid:vout:offset'); fall
    // back to the owning output ('txid:vout') if satpoint is absent.
    let txid = 'unknown';
    let vout = 0;
    const location = info.satpoint || info.output;
    if (typeof location === 'string' && location.includes(':')) {
      const [tid, v] = location.split(':');
      txid = tid;
      vout = Number(v) || 0;
    }

    // Content bytes are a separate call: ord_getInscription returns metadata
    // only. Cap the JSON-RPC body at the base64 expansion of the content cap
    // so legitimately large inscriptions aren't rejected by the JSON cap.
    const contentJsonCap = Math.ceil(this.maxContentBytes * 4 / 3) + 64 * 1024;
    let content: Buffer;
    try {
      const contentResult = await this.rpcCall<unknown>('ord_getContent', [id], contentJsonCap);
      content = this.decodeContent(contentResult, info.content_type || info.effective_content_type);
    } catch (err) {
      if (QuickNodeProvider.isNotFound(err)) return null;
      throw err;
    }

    const satRaw = info.sat;
    const satoshi = satRaw === null || satRaw === undefined ? undefined : String(satRaw);
    const blockHeight = typeof info.height === 'number'
      ? info.height
      : (typeof info.genesis_height === 'number' ? info.genesis_height : undefined);

    return {
      inscriptionId: info.id || info.inscription_id || id,
      content,
      contentType: info.content_type || info.effective_content_type || 'application/octet-stream',
      txid,
      vout,
      satoshi,
      blockHeight,
    };
  }

  async getInscriptionsBySatoshi(satoshi: string) {
    const validation = validateSatoshiNumber(satoshi);
    if (!validation.valid) {
      throw new StructuredError('QUICKNODE_INVALID_SATOSHI', `QuickNodeProvider: ${validation.error}`);
    }
    // Sat ordinals max out at 2,099,999,997,689,999 (< 2^53), so Number is
    // exact here; ord_getSat expects a JSON number, not a string.
    let info: { inscriptions?: string[]; inscription_ids?: string[] } | null;
    try {
      info = await this.rpcCall<{ inscriptions?: string[]; inscription_ids?: string[] } | null>(
        'ord_getSat',
        [Number(satoshi)]
      );
    } catch (err) {
      if (QuickNodeProvider.isNotFound(err)) return [];
      throw err;
    }
    const ids = Array.isArray(info?.inscriptions)
      ? info.inscriptions
      : (Array.isArray(info?.inscription_ids) ? info.inscription_ids : []);
    return ids
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map((inscriptionId) => ({ inscriptionId }));
  }

  async broadcastTransaction(txHexOrObj: unknown): Promise<string> {
    // sendrawtransaction only accepts raw transaction hex. Reject non-hex
    // input up front instead of producing a guaranteed-invalid RPC parameter
    // that fails far from the cause (same hardening as SignetProvider, #272).
    if (typeof txHexOrObj !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(txHexOrObj)) {
      throw new StructuredError(
        'QUICKNODE_INVALID_TX_HEX',
        'QuickNodeProvider.broadcastTransaction requires a raw transaction hex string (even-length hexadecimal)'
      );
    }
    const result = await this.rpcCall<unknown>('sendrawtransaction', [txHexOrObj]);
    // A response with neither result nor error must not become a "successful"
    // empty txid that downstream code records as provenance.
    if (typeof result !== 'string' || result.length === 0) {
      throw new StructuredError(
        'QUICKNODE_BROADCAST_NO_TXID',
        'QuickNodeProvider: sendrawtransaction returned no txid'
      );
    }
    return result;
  }

  async getTransactionStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number; confirmations?: number }> {
    if (typeof txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new StructuredError(
        'QUICKNODE_INVALID_TXID',
        'QuickNodeProvider.getTransactionStatus requires a 64-character hex txid'
      );
    }
    let tx: { confirmations?: number; blockhash?: string } | null;
    try {
      tx = await this.rpcCall<{ confirmations?: number; blockhash?: string } | null>(
        'getrawtransaction',
        [txid.toLowerCase(), true]
      );
    } catch (err) {
      // -5: not in mempool or chain — an unknown tx is "not confirmed", not
      // a transport failure.
      if (QuickNodeProvider.isNotFound(err)) return { confirmed: false };
      throw err;
    }
    if (!tx) return { confirmed: false };
    const confirmations = typeof tx.confirmations === 'number' ? tx.confirmations : 0;
    if (confirmations < 1) {
      return { confirmed: false, confirmations };
    }
    // Verbose getrawtransaction reports blockhash but not height; resolve it
    // via getblockheader when available. Height is optional in the provider
    // contract, so a failure here must not mask a confirmed transaction.
    let blockHeight: number | undefined;
    if (tx.blockhash) {
      try {
        const header = await this.rpcCall<{ height?: number } | null>('getblockheader', [tx.blockhash, true]);
        if (typeof header?.height === 'number') blockHeight = header.height;
      } catch {
        // best-effort only
      }
    }
    return { confirmed: true, confirmations, blockHeight };
  }

  async estimateFee(blocks: number = 1): Promise<number> {
    const target = Math.max(1, Math.floor(blocks));
    const result = await this.rpcCall<{ feerate?: number; errors?: string[] } | null>(
      'estimatesmartfee',
      [target]
    );
    if (typeof result?.feerate !== 'number' || !(result.feerate > 0)) {
      // estimatesmartfee returns { errors: [...] } and no feerate when the
      // node lacks fee data. Refuse to invent a rate — fabricated fees are
      // exactly what the OrdMockProvider replacement is meant to eliminate.
      throw new StructuredError(
        'QUICKNODE_FEE_ESTIMATE_UNAVAILABLE',
        `QuickNodeProvider: estimatesmartfee returned no feerate${result?.errors?.length ? ` (${result.errors.join('; ')})` : ''}. Configure a FeeOracleAdapter or retry with a higher block target.`
      );
    }
    // estimatesmartfee reports BTC/kvB; the provider contract is sat/vB.
    return Math.max(1, Math.ceil(result.feerate * 1e5));
  }

  // QuickNode does not build or sign transactions, so inscription
  // creation/transfer cannot be implemented against it directly. These fail
  // loudly (mirroring OrdinalsClient/OrdHttpProvider hardening, #248/#318)
  // instead of fabricating inscription ids or txids. Build the commit/reveal
  // (src/bitcoin/transactions/commit.ts) or transfer (src/bitcoin/transfer.ts)
  // transaction locally, sign it, and submit via broadcastTransaction.

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
      'QUICKNODE_CREATE_INSCRIPTION_NOT_IMPLEMENTED',
      'QuickNodeProvider.createInscription is not implemented: QuickNode does not construct or sign transactions, and no inscription was created. Build and sign the commit/reveal transactions locally, then submit them via broadcastTransaction.'
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
      'QUICKNODE_TRANSFER_NOT_IMPLEMENTED',
      'QuickNodeProvider.transferInscription is not implemented: QuickNode does not construct or sign transactions, and no transfer was broadcast. Build and sign the transfer transaction locally, then submit it via broadcastTransaction.'
    ));
  }
}
