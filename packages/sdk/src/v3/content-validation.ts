import * as btc from '@scure/btc-signer';
import type { ScriptType } from '@scure/btc-signer';
import { parseInscriptions } from 'micro-ordinals';
import { StructuredError } from '@originals/cel';
import { digestBytes, type SatSnapshot, type IndependentContentEvidence } from '@originals/cel/v3';
import { base64 } from '@scure/base';
import { readResponseBodyCapped } from '../adapters/response-body-limit.js';

/**
 * Independently derive confirmed inscriptions' media type/content from chain data, for
 * cross-checking against `SatSnapshot.publications`. Never discovers trust from provider
 * data: it reads only the sat's reveal transactions, never the primary provider's response.
 *
 * `acceptedInscriptionIds` names exactly the publications the baseline (independent-content-free)
 * resolution actually committed to accepted history — a validator should confine its work to
 * those ids rather than every confirmed publication in the snapshot, since an unrelated,
 * non-extending, boundary-invalid, or height-gated publication the resolver already ignores
 * must never be able to deny an otherwise valid history just because it happens to be
 * unreachable or unparseable on independent re-derivation.
 */
export type ContentValidator = (
  snapshot: Readonly<SatSnapshot>,
  acceptedInscriptionIds: readonly string[],
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

/**
 * Parse a reveal transaction's taproot script-path witness to recover the exact media type
 * and content bytes an Ordinals-compatible interpreter would assign each inscription index,
 * independent of whatever an Ordinals indexer separately reports for the same transaction.
 * Returns an empty array (never throws) when no such witness is found — this validator only
 * asserts what it could independently confirm; it never asserts absence.
 */
type DerivedInscription = { contentType?: string; body: Uint8Array; rawMetadata?: Uint8Array };

const METADATA_TAG = 5;

/**
 * Extract the raw (pre-CBOR-decode) bytes of the metadata tag for each sequential inscription
 * envelope in a script, without invoking any CBOR decoding — so the result is byte-identical
 * to what any raw Ordinals indexer would report for `/r/metadata/:id`, never subject to a
 * canonical-re-encoding mismatch against semantically-equal but differently-encoded CBOR.
 *
 * Only valid once `parseInscriptions(script, true)` has already returned a defined result for
 * this same script: strict mode guarantees every envelope is non-cursed, sequential, and starts
 * immediately after the leading `<pubkey> CHECKSIG` prefix, so this can walk those same
 * boundaries directly (envelope `n`'s payload starts right after envelope `n-1`'s `ENDIF`) without
 * re-deriving cursed/stutter detection itself. Mirrors ord's stable, publicly documented envelope
 * format (`OP_FALSE OP_IF "ord" [tag,data]* OP_0 [body-chunks]* OP_ENDIF`), not an internal
 * micro-ordinals implementation detail, so it does not depend on that library's non-public API.
 */
function rawMetadataPerEnvelope(script: ScriptType, count: number): (Uint8Array | undefined)[] {
  const results: (Uint8Array | undefined)[] = [];
  let pos = 5; // script[0..4] = [pubkey, 'CHECKSIG', 0, 'IF', "ord"]; first envelope's payload starts here
  for (let n = 0; n < count; n++) {
    let end = pos;
    while (script[end] !== 'ENDIF') end++;
    const chunks: Uint8Array[] = [];
    for (let i = pos; i < end && script[i] !== 0; i += 2) {
      const tag = script[i];
      const data = script[i + 1];
      if (tag instanceof Uint8Array && tag.length === 1 && tag[0] === METADATA_TAG && data instanceof Uint8Array) {
        chunks.push(data);
      }
    }
    results.push(chunks.length ? btc.utils.concatBytes(...chunks) : undefined);
    pos = end + 4; // ENDIF, then the next envelope's [0, 'IF', "ord"]
  }
  return results;
}

/**
 * Parse a reveal transaction's taproot script-path witness to recover the exact media type
 * and content bytes an Ordinals-compatible interpreter would assign each inscription index,
 * independent of whatever an Ordinals indexer separately reports for the same transaction.
 * Returns an empty array (never throws) when no such witness is found, or when the raw bytes
 * returned by the node do not actually hash to `expectedTxid` — this validator only asserts
 * what it could independently confirm; it never asserts absence, and never assigns witness
 * data from a transaction other than the one actually requested.
 */
function deriveFromRawTransaction(rawHex: string, expectedTxid: string): DerivedInscription[] {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromRaw(Buffer.from(rawHex, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
  } catch {
    return [];
  }
  // The independently-trusted node's own computed identity for these bytes must match
  // the txid actually requested. Otherwise this is not evidence about the requested
  // reveal transaction at all -- whether from a misbehaving/misconfigured node or an
  // on-path substitution -- and must never be assigned to that inscription's witness.
  if (tx.id !== expectedTxid) return [];
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
      const rawMetadata = rawMetadataPerEnvelope(decoded, parsed.length);
      parsed.forEach((inscription, index) => {
        inscriptions.push({
          contentType: inscription.tags.contentType,
          body: inscription.body,
          rawMetadata: rawMetadata[index],
        });
      });
    } catch {
      continue;
    }
  }
  return inscriptions;
}

/**
 * Cross-check confirmed inscriptions' media type and content bytes against a separately
 * trusted Core node's raw transaction data, interpreted with this SDK's own Ordinals envelope
 * parser. This does not authenticate chain tip/block facts (`createBitcoinCoreChainValidator`)
 * or Ordinals enumeration/ownership completeness (`independentEnumeration`) — only whether the
 * content a provider reports for a given confirmed inscription id actually matches what is
 * encoded on-chain for that reveal transaction.
 */
const isLoopbackHost = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

export function createBitcoinCoreContentValidator(
  options: BitcoinCoreContentValidatorOptions,
): ContentValidator {
  const endpoint = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new StructuredError('CONTENT_VALIDATOR_CONFIG', 'Use an HTTP(S) Core endpoint without URL credentials or a fragment');
  }
  // Plaintext HTTP exposes any configured Basic RPC credentials and lets an on-path
  // attacker alter the "independent" evidence in transit, defeating the cross-check
  // this validator exists to provide. Only exempt an endpoint that cannot leave the
  // local machine in the first place.
  if (endpoint.protocol === 'http:' && !isLoopbackHost(endpoint.hostname)) {
    throw new StructuredError('CONTENT_VALIDATOR_CONFIG', 'A non-loopback Core endpoint must use HTTPS');
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.rpcAuth) headers.set('authorization', 'Basic ' + base64.encode(
    new TextEncoder().encode(`${options.rpcAuth.username}:${options.rpcAuth.password}`)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positive(options.timeoutMs, 15_000);
  const maxRequests = positive(options.maxRequests, 512);
  const maxBytes = positive(options.maxResponseBytes, 8 * 1024 * 1024);

  return async (snapshot, acceptedInscriptionIds) => {
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
      // Limited to publications the baseline (independent-content-free) resolution
      // actually committed to accepted history: an unrelated, non-extending,
      // boundary-invalid, or height-gated publication the resolver already ignores
      // must never be able to deny an otherwise valid history just because it is
      // unreachable or unparseable on independent re-derivation. Also deduplicates by
      // inscription id -- a snapshot can legitimately carry duplicate observations of
      // one publication, and reporting more than one evidence entry for the same id
      // would itself be rejected as malformed, invalidating an otherwise-accepted result.
      const acceptedIds = new Set(acceptedInscriptionIds);
      const seen = new Set<string>();
      const evidence: IndependentContentEvidence[] = [];
      const rawTxByTxid = new Map<string, string>();
      for (const publication of snapshot.publications) {
        if (!acceptedIds.has(publication.id) || seen.has(publication.id)) continue;
        if (publication.confirmed !== true || publication.body?.status !== 'complete') continue;
        const match = inscriptionId.exec(publication.id);
        if (!match) continue;
        seen.add(publication.id);
        const [, txid, indexText] = match;
        let rawHex = rawTxByTxid.get(txid);
        if (rawHex === undefined) {
          const result = await rpc('getrawtransaction', [txid, 0, publication.creation?.blockHash]);
          if (typeof result !== 'string') throw unavailable();
          rawHex = result;
          rawTxByTxid.set(txid, rawHex);
        }
        const inscriptions = deriveFromRawTransaction(rawHex, txid);
        const inscription = inscriptions[Number(indexText)];
        // No independently parseable envelope at this index (including a
        // txid-mismatched response): leave this inscription uncovered
        // (contentAssurance stays provider-asserted) rather than guessing.
        if (!inscription) continue;
        evidence.push({
          inscriptionId: publication.id,
          mediaType: inscription.contentType ?? '',
          contentDigest: digestBytes(inscription.body),
          metadataDigest: inscription.rawMetadata === undefined ? null : digestBytes(inscription.rawMetadata),
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
