import { MAX_SCRIPT_BYTE_LENGTH } from '@scure/btc-signer';

/** Ordinals envelope tag byte for `metadata`, per micro-ordinals' `TagEnum`. */
export const METADATA_TAG = 5;

/**
 * Split pre-encoded CBOR document bytes into Ordinals `metadata`-tagged script pushes, for use
 * as `Inscription.tags.unknown` (raw tag/data pairs) rather than `tags.metadata`.
 *
 * micro-ordinals' own CBOR encoder (used for `tags.metadata`) cannot encode a JS `number` in
 * `[2^32, 2^53)` — a `micro-packed` `U64BE`/bigint coercion limitation — which permanently blocks
 * the default inline Bitcoin publication path for a CEL document containing such a value, even
 * though the value is validly CEL-representable and CEL's own deterministic CBOR writer
 * (`encodeDocument(document, "cbor")`) encodes it without issue. Writing those bytes verbatim
 * under the same tag byte, instead of asking micro-ordinals to re-derive them from a JS object,
 * sidesteps that limitation entirely. Readers must extract this tag's bytes the same raw way
 * (see `rawMetadataPerEnvelope` in `packages/sdk/src/v3/content-validation.ts`) rather than
 * through `Inscription.tags.metadata`, which still round-trips through that limited decoder.
 */
export function metadataTagChunks(bytes: Uint8Array): [Uint8Array, Uint8Array][] {
  const tag = new Uint8Array([METADATA_TAG]);
  const chunks: [Uint8Array, Uint8Array][] = [];
  for (let i = 0; i < bytes.length; i += MAX_SCRIPT_BYTE_LENGTH)
    chunks.push([tag, bytes.subarray(i, i + MAX_SCRIPT_BYTE_LENGTH)]);
  return chunks;
}
