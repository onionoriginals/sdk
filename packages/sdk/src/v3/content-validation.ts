import * as btc from '@scure/btc-signer';
import { parseInscriptions, __test__ as microOrdinalsInternals } from 'micro-ordinals';
import { StructuredError } from '@originals/cel';
import { digestBytes, type SatSnapshot, type IndependentContentEvidence } from '@originals/cel/v3';
import { base64 } from '@scure/base';
import { readResponseBodyCapped } from '../adapters/response-body-limit.js';

/**
 * Independently derive confirmed inscriptions' media type/content from chain data, for
 * cross-checking against `SatSnapshot.publications`. Never discovers trust from provider
 * data: it reads only the sat's reveal transactions, never the primary provider's response.
 */
export type ContentValidator = (
  snapshot: Readonly<SatSnapshot>,
) => Promise<IndependentContentEvidence[]>;

export interface BitcoinCoreContentValidatorOptions {
  /** A separately operated Bitcoin Core RPC endpoint. Credentials belong in rpcAuth, not the URL. */
  endpoint: string;
  rpcAuth?: { username: string; password: string };
  fetchImpl?: typeof fetch;
  /** Whole validation deadline, including streamed response bodies. Default 15 seconds. */
  timeoutMs?: number;
  /** Maximum total RPC calls per validation. Default 512. Costs at most one `getrawtransaction` per distinct reveal txid. */
  maxRequests?: number;
  /** Streaming limit for each RPC response. Default 8 MiB. */
  maxResponseBytes?: number;
}

const positive = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
const inscriptionId = /^([0-9a-f]{64})i(0|[1-9]\d*)$/;
/** Ordinals inscription envelope tag number for the metadata field (protocol-fixed). */
const METADATA_TAG = 5;

// `parseInscriptions`'s public surface only returns each tag already CBOR-decoded, so
// recovering the metadata tag's *raw* wire bytes — needed to compare exact on-chain bytes
// rather than a re-encoded value — means walking the same envelope/tag-chunk structure
// `parseInscriptions` itself parses. Reuse micro-ordinals' own (package-exported, if
// test-labeled) `parseEnvelopes` for envelope/tag-boundary detection rather than
// reimplementing that scan: it is the exact same code `parseInscriptions` already uses, so
// envelope indices are guaranteed to line up with `parseInscriptions`' inscription order,
// and this file never becomes a second, independently-maintained envelope parser.
type ParsedScript = Parameters<typeof parseInscriptions>[0];
type RawEnvelope = { payload: ReadonlyArray<Uint8Array | number> };
const parseEnvelopes = (microOrdinalsInternals as { parseEnvelopes: (script: ParsedScript) => RawEnvelope[] }).parseEnvelopes;

/**
 * Extract each envelope's raw (pre-CBOR-decode) metadata tag bytes, exactly as pushed
 * on-chain, in the same order `parseInscriptions` returns inscriptions for this script.
 * Mirrors `TagCoder`'s tag-chunk-concatenation rule (a tag can be split across multiple
 * `{tag, data}` pushes when its value exceeds the max script push size; all data chunks for
 * a given tag concatenate in encounter order) without CBOR-decoding the result.
 */
function deriveRawMetadataPerEnvelope(script: ParsedScript): (Uint8Array | undefined)[] {
  return parseEnvelopes(script).map(({ payload }) => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i + 1 < payload.length && payload[i] !== 0; i += 2) {
      const tag = payload[i];
      const data = payload[i + 1];
      if (tag instanceof Uint8Array && tag.length === 1 && tag[0] === METADATA_TAG && data instanceof Uint8Array)
        chunks.push(data);
    }
    return chunks.length ? btc.utils.concatBytes(...chunks) : undefined;
  });
}

/**
 * Parse a reveal transaction's taproot script-path witness to recover the exact media type
 * and content bytes an Ordinals-compatible interpreter would assign each inscription index,
 * independent of whatever an Ordinals indexer separately reports for the same transaction.
 * Returns an empty array (never throws) when no such witness is found — this validator only
 * asserts what it could independently confirm; it never asserts absence.
 */
type DerivedInscription = { tags: { contentType?: string }; body: Uint8Array; rawMetadata?: Uint8Array };

function deriveFromRawTransaction(rawHex: string): DerivedInscription[] {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromRaw(Buffer.from(rawHex, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
  } catch {
    return [];
  }
  // An inscription id's index is global across the whole reveal transaction, not
  // scoped to one input: a batch reveal can carry inscriptions across multiple
  // script-path inputs, each contributing its envelopes in input order.
  const inscriptions: DerivedInscription[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const witness = tx.getInput(i).finalScriptWitness;
    if (!witness || witness.length !== 3) continue;
    try {
      const decoded = btc.Script.decode(witness[1]);
      const parsed = parseInscriptions(decoded, true);
      if (!parsed?.length) continue;
      const rawMetadataByEnvelope = deriveRawMetadataPerEnvelope(decoded);
      parsed.forEach((inscription, index) => {
        inscriptions.push({ ...inscription, rawMetadata: rawMetadataByEnvelope[index] });
      });
    } catch {
      continue;
    }
  }
  return inscriptions;
}

/**
 * Compares exact on-chain metadata tag bytes rather than a re-encoded decoded value: two
 * honest observers of the same reveal transaction always agree, independent of any CBOR
 * encoder's canonicalization choices (map key order, integer width). This avoids the false
 * disagreement a decode-then-canonically-reencode comparison would produce for valid but
 * non-canonically-encoded metadata that this SDK's own writer did not itself produce.
 */
function metadataDigest(rawMetadata: Uint8Array | undefined): string | null {
  return rawMetadata === undefined ? null : digestBytes(rawMetadata);
}

/**
 * Cross-check confirmed inscriptions' media type and content bytes against a separately
 * trusted Core node's raw transaction data, interpreted with this SDK's own Ordinals envelope
 * parser. This does not authenticate chain tip/block facts (`createBitcoinCoreChainValidator`)
 * or Ordinals enumeration/ownership completeness (`independentEnumeration`) — only whether the
 * content a provider reports for a given confirmed inscription id actually matches what is
 * encoded on-chain for that reveal transaction.
 */
export function createBitcoinCoreContentValidator(
  options: BitcoinCoreContentValidatorOptions,
): ContentValidator {
  const endpoint = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new StructuredError('CONTENT_VALIDATOR_CONFIG', 'Use an HTTP(S) Core endpoint without URL credentials or a fragment');
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.rpcAuth) headers.set('authorization', 'Basic ' + base64.encode(
    new TextEncoder().encode(`${options.rpcAuth.username}:${options.rpcAuth.password}`)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positive(options.timeoutMs, 15_000);
  const maxRequests = positive(options.maxRequests, 512);
  const maxBytes = positive(options.maxResponseBytes, 8 * 1024 * 1024);

  return async (snapshot) => {
    const controller = new AbortController();
    const unavailable = () => new StructuredError('CONTENT_VALIDATOR_UNAVAILABLE', 'Independent Bitcoin Core content validation is unavailable');
    const budgetExceeded = () => new StructuredError('CONTENT_VALIDATOR_BUDGET_EXCEEDED', 'Independent content validation budget exceeded');
    let requests = 0;
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectDeadline(budgetExceeded()); }, timeoutMs);
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      if (controller.signal.aborted || ++requests > maxRequests) throw budgetExceeded();
      try {
        const response = await fetchImpl(endpoint.href, { method: 'POST', headers, signal: controller.signal,
          redirect: 'error', credentials: 'omit', cache: 'no-store', body: JSON.stringify({ jsonrpc: '2.0', id: requests, method, params }) });
        if (!response.ok) throw unavailable();
        const body = JSON.parse(new TextDecoder().decode(await readResponseBodyCapped(response, maxBytes))) as
          { result?: unknown; error?: unknown };
        if (body.error || !('result' in body)) throw unavailable();
        return body.result;
      } catch {
        if (controller.signal.aborted) throw budgetExceeded();
        throw unavailable();
      }
    };
    const derive = async (): Promise<IndependentContentEvidence[]> => {
      const evidence: IndependentContentEvidence[] = [];
      const rawTxByTxid = new Map<string, string>();
      for (const publication of snapshot.publications) {
        if (publication.confirmed !== true || publication.body?.status !== 'complete') continue;
        const match = inscriptionId.exec(publication.id);
        if (!match) continue;
        const [, txid, indexText] = match;
        let rawHex = rawTxByTxid.get(txid);
        if (rawHex === undefined) {
          const result = await rpc('getrawtransaction', [txid, 0, publication.creation?.blockHash]);
          if (typeof result !== 'string') throw unavailable();
          rawHex = result;
          rawTxByTxid.set(txid, rawHex);
        }
        const inscriptions = deriveFromRawTransaction(rawHex);
        const inscription = inscriptions[Number(indexText)];
        // No independently parseable envelope at this index: leave this inscription
        // uncovered (contentAssurance stays provider-asserted) rather than guessing.
        if (!inscription) continue;
        evidence.push({
          inscriptionId: publication.id,
          mediaType: inscription.tags.contentType ?? '',
          contentDigest: digestBytes(inscription.body),
          metadataDigest: metadataDigest(inscription.rawMetadata),
        });
      }
      return evidence;
    };
    try {
      return await Promise.race([derive(), deadline]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
