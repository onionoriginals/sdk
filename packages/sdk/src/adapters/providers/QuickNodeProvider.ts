import type { SatSnapshot } from '@originals/cel/v3';
import { readSatSnapshot, type SatSnapshotBudget } from './sat-snapshot.js';
import type { OrdinalsProvider, InscriptionParts } from '../types.js';
import { enumerateAnchoringsOnSat, type DidCelAnchoring } from '../anchoring-enumeration.js';
import { StructuredError } from '@originals/cel';
import { validateSatoshiNumber } from '@originals/cel';
import { decode as decodeCbor } from '@originals/cel/cbor';
import { hexToBytes } from '@originals/cel/encoding';

export interface QuickNodeProviderOptions {
  /** Bounds the whole CEL 3 evidence scan, not only each HTTP request. */
  snapshotBudget?: SatSnapshotBudget;
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
  /**
   * Bitcoin network this endpoint is expected to serve. When set, the
   * provider verifies `getblockchaininfo.chain` against it on first RPC use
   * and fails loudly on a mismatch — a mainnet-configured SDK pointed at a
   * testnet endpoint would otherwise silently answer mainnet DID
   * existence/transfer questions with testnet data (issue #350).
   */
  expectedNetwork?: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  /**
   * How `ord_getContent` results are encoded (issue #350):
   * - 'base64': only for a gateway explicitly configured to base64-encode; malformed base64 fails loudly.
   * - 'utf8': treat the result as literal UTF-8 text.
   * - 'auto' (default, for backwards compatibility): heuristic — base64-shaped
   *   content is decoded, anything else is treated as literal UTF-8. Ambiguous
   *   short text inscriptions can be misdecoded; pin an explicit encoding for
   *   deployments where content hashes matter.
   */
  contentEncoding?: 'base64' | 'utf8' | 'auto';
  /** Explicit ord-compatible base URL serving raw /content/:id and /r/metadata/:id. Used for CEL 3 snapshots instead of their JSON-RPC wrappers. */
  contentBaseUrl?: string;
}

/** getblockchaininfo.chain values mapped to SDK network names. */
const CHAIN_TO_NETWORK: Record<string, 'mainnet' | 'testnet' | 'signet' | 'regtest'> = {
  main: 'mainnet',
  test: 'testnet', // testnet3 (older bitcoind)
  testnet3: 'testnet',
  testnet4: 'testnet', // modern bitcoind reports 'testnet4' for testnet4
  signet: 'signet',
  regtest: 'regtest',
};

/** Shape gate for inscription ids: 64-hex txid + 'i' + numeric index. */
const INSCRIPTION_ID_RE = /^[0-9a-f]{64}i\d+$/i;
const TXID_RE = /^[0-9a-f]{64}$/i;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_JSON_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 5 * 1024 * 1024;

/** Bitcoin Core RPC error code for "No such mempool or blockchain transaction". */
const RPC_INVALID_ADDRESS_OR_KEY = -5;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

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
  private readonly expectedNetwork?: 'mainnet' | 'testnet' | 'signet' | 'regtest';
  private readonly contentEncoding: 'base64' | 'utf8' | 'auto';
  private readonly contentBaseUrl?: string;
  private networkCheck: Promise<void> | null = null;

  private readonly snapshotBudget: SatSnapshotBudget;

  constructor(options: QuickNodeProviderOptions) {
    if (!options?.endpoint) {
      throw new StructuredError('QUICKNODE_ENDPOINT_REQUIRED', 'QuickNodeProvider requires an endpoint URL');
    }
    let parsed: URL;
    try {
      parsed = new URL(options.endpoint);
    } catch {
      // Never echo the endpoint string back: the QuickNode auth token is
      // embedded in the URL path and error text lands in logs/telemetry
      // (issue #350).
      throw new StructuredError('QUICKNODE_ENDPOINT_INVALID', 'QuickNodeProvider endpoint is not a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new StructuredError('QUICKNODE_ENDPOINT_INVALID', `QuickNodeProvider endpoint must be http(s), got ${parsed.protocol}`);
    }
    this.snapshotBudget = { ...options.snapshotBudget };
    this.endpoint = options.endpoint;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
    this.maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
    this.expectedNetwork = options.expectedNetwork;
    this.contentEncoding = options.contentEncoding ?? 'auto';
    if (options.contentBaseUrl !== undefined) {
      try {
        const content = new URL(options.contentBaseUrl);
        if (!['http:', 'https:'].includes(content.protocol) || content.search || content.hash || content.username || content.password) throw new Error();
        this.contentBaseUrl = content.href.replace(/\/$/, '');
      } catch { throw new StructuredError('QUICKNODE_CONTENT_ENDPOINT_INVALID', 'contentBaseUrl must be an HTTP(S) base URL without query, fragment or userinfo'); }
    }
  }

  /**
   * Verify the endpoint's chain matches the expected network (issue #350).
   * Runs once before the first real RPC call; the memoized promise is reset
   * on failure so a transient RPC error does not poison the provider forever.
   */
  private ensureExpectedNetwork(): Promise<void> {
    if (!this.expectedNetwork) return Promise.resolve();
    if (!this.networkCheck) {
      this.networkCheck = (async () => {
        const info = await this.rpcCall<{ chain?: string } | null>('getblockchaininfo', []);
        const chain = info?.chain;
        const actual = typeof chain === 'string' ? CHAIN_TO_NETWORK[chain] : undefined;
        if (actual !== this.expectedNetwork) {
          throw new StructuredError(
            'QUICKNODE_NETWORK_MISMATCH',
            `QuickNodeProvider: endpoint serves chain '${String(chain)}' (${String(actual)}) but the SDK is configured for ${this.expectedNetwork}. ` +
            'Point QUICKNODE_ENDPOINT at an endpoint on the configured network.'
          );
        }
      })().catch((err) => {
        // Only reset for transient errors so a permanent QUICKNODE_NETWORK_MISMATCH
        // doesn't cause a redundant getblockchaininfo call on every subsequent retry.
        if (!(err instanceof StructuredError) || err.code !== 'QUICKNODE_NETWORK_MISMATCH') {
          this.networkCheck = null;
        }
        throw err;
      });
    }
    return this.networkCheck;
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
  private async rpcCall<T>(method: string, params: unknown[], maxBytes?: number, signal?: AbortSignal): Promise<T> {
    const cap = maxBytes ?? this.maxJsonBytes;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout),
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
   * True when the endpoint does not implement an RPC method (JSON-RPC -32601 or
   * an ord/gateway "method not found" message) — distinct from a transient
   * transport fault, which must propagate. Used so a missing `ord_getMetadata`
   * (older ord add-on) degrades to "no metadata" while a 500/timeout does not.
   */
  private static isMethodNotFound(err: unknown): boolean {
    if (!(err instanceof StructuredError) || err.code !== 'QUICKNODE_RPC_ERROR') return false;
    if (err.details?.rpcCode === JSON_RPC_METHOD_NOT_FOUND) return true;
    const rpcMessage = err.details?.rpcMessage;
    return typeof rpcMessage === 'string' && /method not found/i.test(rpcMessage);
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
    const isBase64Shaped = compact.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0;
    if (this.contentEncoding === 'base64') {
      // Explicit encoding: no guessing. Content that is not valid base64 is a
      // server contract violation, not literal text (issue #350).
      if (compact !== '' && (!isBase64Shaped || Buffer.from(compact, 'base64').toString('base64') !== compact)) {
        throw new StructuredError(
          'QUICKNODE_CONTENT_UNEXPECTED_SHAPE',
          "QuickNodeProvider: ord_getContent result is not base64 (provider configured with contentEncoding: 'base64')"
        );
      }
      buf = Buffer.from(compact, 'base64');
    } else if (this.contentEncoding === 'utf8') {
      buf = Buffer.from(raw, 'utf8');
    } else if (isBase64Shaped) {
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
    await this.ensureExpectedNetwork();
    let info: QuickNodeInscription | null;
    try {
      info = await this.rpcCall<QuickNodeInscription | null>('ord_getInscription', [id]);
    } catch (err) {
      if (QuickNodeProvider.isNotFound(err)) return null;
      throw err;
    }
    if (!info) return null;

    // Validate server-supplied fields BEFORE they flow into provenance
    // records (issue #350): a compromised endpoint must not be able to inject
    // arbitrary strings as txid/inscriptionId/satoshi. Malformed data is a
    // contract violation and throws — it is not "not found".
    const inscriptionId = info.id || info.inscription_id || id;
    if (!INSCRIPTION_ID_RE.test(inscriptionId)) {
      throw new StructuredError(
        'QUICKNODE_UNEXPECTED_SHAPE',
        `QuickNodeProvider: ord_getInscription returned a malformed inscription id (${inscriptionId})`
      );
    }

    // Current location comes from the satpoint ('txid:vout:offset'); fall
    // back to the owning output ('txid:vout') if satpoint is absent. A
    // missing or malformed location throws rather than fabricating the
    // literal 'unknown' as a txid.
    const location = info.satpoint || info.output;
    const [tid, v] = typeof location === 'string' ? location.split(':') : [];
    if (!tid || !TXID_RE.test(tid)) {
      throw new StructuredError(
        'QUICKNODE_UNEXPECTED_SHAPE',
        'QuickNodeProvider: ord_getInscription returned no valid satpoint/output location'
      );
    }
    const txid = tid;
    const vout = Number(v) || 0;

    const satRaw = info.sat;
    let satoshi: string | undefined;
    if (satRaw !== null && satRaw !== undefined) {
      satoshi = String(satRaw);
      if (!validateSatoshiNumber(satoshi).valid) {
        throw new StructuredError(
          'QUICKNODE_UNEXPECTED_SHAPE',
          `QuickNodeProvider: ord_getInscription returned an invalid sat number (${satoshi})`
        );
      }
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
      // The inscription's metadata EXISTS (ord_getInscription succeeded), so
      // a content-lookup miss (e.g. indexer lag) is "content unavailable",
      // not "inscription does not exist". Returning null here made
      // verifyBitcoinWitnessProof report a hard false negative for a real
      // on-chain anchor (issue #350).
      if (QuickNodeProvider.isNotFound(err)) {
        throw new StructuredError(
          'QUICKNODE_CONTENT_UNAVAILABLE',
          `QuickNodeProvider: inscription ${id} exists but its content is not yet available from the endpoint (possible indexer lag); retry later`,
          { inscriptionId: id }
        );
      }
      throw err;
    }

    const blockHeight = typeof info.height === 'number'
      ? info.height
      : (typeof info.genesis_height === 'number' ? info.genesis_height : undefined);

    // #407 phase 3: decode the inscription's CBOR metadata so a real chain can
    // be walked/reconstructed. Absent → undefined; present-but-undecodable →
    // fail closed (never a silent partial reconstruction).
    const metadata = await this.fetchMetadata(id, info);

    return {
      inscriptionId,
      content,
      contentType: info.content_type || info.effective_content_type || 'application/octet-stream',
      txid,
      vout,
      satoshi,
      blockHeight,
      ...(metadata !== undefined ? { metadata } : {}),
    };
  }

  /**
   * The first (lowest-offset) sat in an output, per the Ordinals & Runes API's
   * sat-range index (mirrors ord's `/output/<OUTPOINT>` `sat_ranges`). Used to
   * derive a did:btco identity BEFORE building the inscription that will land
   * on it, so an empty/error response must fail loudly rather than fabricate
   * a sat that would mint a wrong DID.
   */
  async getFirstSatOfOutput(outpoint: { txid: string; vout: number }): Promise<string> {
    if (!TXID_RE.test(outpoint.txid) || !Number.isInteger(outpoint.vout) || outpoint.vout < 0) {
      throw new StructuredError(
        'QUICKNODE_INVALID_OUTPOINT',
        'QuickNodeProvider.getFirstSatOfOutput requires a valid { txid, vout } outpoint'
      );
    }
    await this.ensureExpectedNetwork();
    const outpointStr = `${outpoint.txid}:${outpoint.vout}`;
    let info: { sat_ranges?: Array<[number | string, number | string]> } | null;
    try {
      info = await this.rpcCall<{ sat_ranges?: Array<[number | string, number | string]> } | null>(
        'ord_getOutput',
        [outpointStr]
      );
    } catch (err) {
      // Any RPC/transport failure — including "not found" — means the sat
      // index has nothing for this output. Never guess a sat here.
      throw new StructuredError(
        'SAT_INDEX_UNAVAILABLE',
        `QuickNodeProvider: could not fetch sat index for output ${outpointStr}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const ranges = info?.sat_ranges;
    if (!Array.isArray(ranges) || ranges.length === 0 || !Array.isArray(ranges[0])) {
      throw new StructuredError(
        'SAT_INDEX_UNAVAILABLE',
        `QuickNodeProvider: no sat ranges returned for output ${outpointStr} (sat index may not be enabled on this endpoint)`
      );
    }
    const satoshi = String(ranges[0][0]);
    if (!validateSatoshiNumber(satoshi).valid) {
      throw new StructuredError(
        'SAT_INDEX_UNAVAILABLE',
        `QuickNodeProvider: sat index returned an invalid sat number (${satoshi}) for output ${outpointStr}`
      );
    }
    return satoshi;
  }

  /**
   * Fetch + CBOR-decode an inscription's metadata (#407 phase 3). Prefers an
   * inline hex `metadata` field on the `ord_getInscription` result, else the
   * `ord_getMetadata` RPC. Returns `undefined` when no metadata exists (RPC
   * not-found / absent field). Throws a clear fail-closed error when metadata
   * bytes are PRESENT but cannot be hex/CBOR decoded.
   */
  private async fetchMetadata(id: string, info: QuickNodeInscription): Promise<Record<string, unknown> | undefined> {
    let hex: string | undefined;
    const inlineMeta = (info as { metadata?: unknown }).metadata;
    if (typeof inlineMeta === 'string' && inlineMeta.length > 0) {
      hex = inlineMeta;
    } else {
      let raw: unknown;
      try {
        raw = await this.rpcCall<unknown>('ord_getMetadata', [id]);
      } catch (err) {
        // ONLY degrade to undefined when the metadata genuinely isn't there:
        // the endpoint lacks ord_getMetadata (older add-on → JSON-RPC method
        // not found) or the inscription has none (isNotFound). A transient
        // fault (HTTP 500, timeout, rate-limit) must PROPAGATE — swallowing it
        // would let the resolver silently truncate the chain to a stale log.
        // Fable I2.
        if (QuickNodeProvider.isNotFound(err) || QuickNodeProvider.isMethodNotFound(err)) return undefined;
        throw err;
      }
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        const inner = obj.metadata ?? obj.hex ?? obj.data;
        if (typeof inner === 'string') hex = inner;
        else return raw as Record<string, unknown>; // already decoded object
      } else if (typeof raw === 'string') {
        hex = raw;
      } else {
        return undefined;
      }
    }
    if (!hex) return undefined;
    try {
      return decodeCbor<Record<string, unknown>>(hexToBytes(hex));
    } catch (e) {
      throw new StructuredError(
        'QUICKNODE_METADATA_UNDECODABLE',
        `QuickNodeProvider: inscription ${id} carries metadata that could not be hex/CBOR decoded (${e instanceof Error ? e.message : String(e)}); refusing to reconstruct from partial provenance`,
        { inscriptionId: id }
      );
    }
  }

  /**
   * Complete CEL 3 evidence from the Ordinals & Runes add-on and active Core blocks.
   * Pin contentEncoding to the endpoint's wire contract: 'utf8' for the
   * documented literal text result, 'base64' only for gateways configured to
   * encode binary content that way. Auto mode
   * cannot attest exact bytes. With contentBaseUrl, use ord's raw content and
   * metadata routes, including its explicit inscription-specific absence marker.
   * Otherwise ord_getMetadata must return raw hex or explicit null. Decoded
   * objects, unavailable routes and ambiguous RPC errors fail.
   * https://www.quicknode.com/docs/bitcoin/ord_getMetadata
   * https://www.quicknode.com/docs/bitcoin/ord_getContent
   */
  async getSatSnapshot(satoshi: string): Promise<SatSnapshot> {
    if (!this.contentBaseUrl && this.contentEncoding === 'auto') throw new StructuredError(
      'QUICKNODE_SNAPSHOT_ENCODING_REQUIRED', 'CEL 3 snapshots require an explicit contentEncoding wire contract',
    );
    return readSatSnapshot({
      rpc: (method, params, signal) => this.rpcCall(method, params, undefined, signal),
      status: signal => this.rpcCall('ord_getStatus', [], undefined, signal),
      indexHash: (height, signal) => this.rpcCall('ord_getBlockHash', [height], undefined, signal),
      sat: (sat, signal) => this.rpcCall('ord_getSat', [Number(sat)], undefined, signal),
      inscription: (id, signal) => this.rpcCall('ord_getInscription', [id], undefined, signal),
      content: async (id, signal) => {
        if (this.contentBaseUrl) {
          const response = await fetch(this.contentBaseUrl + '/content/' + id, {
            headers: { Accept: 'application/octet-stream' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout),
          });
          if (response.status === 404) return null;
          if (!response.ok) throw new StructuredError('QUICKNODE_CONTENT_UNAVAILABLE', 'Raw inscription content request failed');
          if (Number(response.headers.get('content-length')) > this.maxContentBytes) throw new StructuredError('QUICKNODE_RESPONSE_TOO_LARGE', 'Raw inscription content exceeds configured limit');
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > this.maxContentBytes) throw new StructuredError('QUICKNODE_RESPONSE_TOO_LARGE', 'Raw inscription content exceeds configured limit');
          return bytes;
        }
        let result = await this.rpcCall<unknown>('ord_getContent', [id], Math.ceil(this.maxContentBytes * 4 / 3) + 64 * 1024, signal);
        // The documented wrapper carries literal content; never re-serialize
        // decoded objects or guess whether an alphanumeric string is base64.
        if (result === null) return null;
        if (typeof result === 'object' && !Array.isArray(result)) result = (result as { content?: unknown }).content;
        if (typeof result !== 'string') throw new StructuredError('QUICKNODE_CONTENT_UNEXPECTED_SHAPE', 'Snapshot content must use the configured string encoding');
        return this.decodeContent(result);
      },
      metadata: async (id, signal) => {
        if (!this.contentBaseUrl) return this.rpcCall('ord_getMetadata', [id], undefined, signal);
        const response = await fetch(this.contentBaseUrl + '/r/metadata/' + id, {
          headers: { Accept: 'application/json' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout),
        });
        if (Number(response.headers.get('content-length')) > this.maxJsonBytes) throw new StructuredError('QUICKNODE_RESPONSE_TOO_LARGE', 'Raw metadata exceeds configured limit');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > this.maxJsonBytes) throw new StructuredError('QUICKNODE_RESPONSE_TOO_LARGE', 'Raw metadata exceeds configured limit');
        const text = new TextDecoder().decode(bytes);
        // A generic gateway 404 can mean the route is unavailable. Only ord's
        // matching inscription-specific marker attests absent metadata.
        if (response.status === 404 && text.trim() === `inscription ${id} metadata not found`) return null;
        if (!response.ok) throw new StructuredError('QUICKNODE_METADATA_UNAVAILABLE', 'Raw inscription metadata request failed');
        const metadata: unknown = JSON.parse(text);
        if (typeof metadata !== 'string') throw new StructuredError('QUICKNODE_METADATA_UNAVAILABLE', 'Raw inscription metadata must be a hex string');
        return metadata;
      },
    }, satoshi, this.expectedNetwork, this.snapshotBudget, 'quicknode');
  }

  async getInscriptionsBySatoshi(satoshi: string) {
    const validation = validateSatoshiNumber(satoshi);
    if (!validation.valid) {
      throw new StructuredError('QUICKNODE_INVALID_SATOSHI', `QuickNodeProvider: ${validation.error}`);
    }
    await this.ensureExpectedNetwork();
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
    // Shape-gate server-supplied ids before they flow into DID resolution /
    // provenance (issue #350).
    return ids
      .filter((x): x is string => typeof x === 'string' && INSCRIPTION_ID_RE.test(x))
      .map((inscriptionId) => ({ inscriptionId }));
  }

  /**
   * SAT-SCOPED tier of the OrdinalsProvider contract (#473): enumerates only
   * the anchorings on `opts.satoshi` via ord_getSat + ord_getInscription.
   * Proves the claimed anchoring exists back-linked and confirmed on that sat;
   * does NOT check cross-sat canonicality. Throws without a sat scope.
   */
  async getAnchoringsForDidCel(didCel: string, opts?: { satoshi?: string }): Promise<DidCelAnchoring[]> {
    return enumerateAnchoringsOnSat(this, didCel, opts?.satoshi, 'QuickNodeProvider');
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
    await this.ensureExpectedNetwork();
    const result = await this.rpcCall<unknown>('sendrawtransaction', [txHexOrObj]);
    // A malformed or empty result must not become a "successful" txid that
    // downstream code records as provenance — require a real 64-char hex txid.
    if (typeof result !== 'string' || !/^[0-9a-fA-F]{64}$/.test(result)) {
      throw new StructuredError(
        'QUICKNODE_BROADCAST_NO_TXID',
        'QuickNodeProvider: sendrawtransaction did not return a valid 64-character hex txid'
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
    await this.ensureExpectedNetwork();
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
    await this.ensureExpectedNetwork();
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

  createInscription(params: {
    data?: Uint8Array;
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
    content?: Uint8Array;
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
