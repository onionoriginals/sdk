import * as btc from '@scure/btc-signer';
import { MAX_SCRIPT_BYTE_LENGTH, type ScriptType } from '@scure/btc-signer';

/** Ordinals envelope tag byte for `metadata`, per micro-ordinals' `TagEnum`. */
export const METADATA_TAG = 5;

/**
 * Split pre-encoded CBOR document bytes into Ordinals `metadata`-tagged script pushes, for use
 * as `Inscription.tags.unknown` (raw tag/data pairs) rather than `tags.metadata`.
 *
 * micro-ordinals' own CBOR encoder (used for `tags.metadata`) cannot encode a JS `number` in
 * `[2^32, 2^53)` — a `micro-packed` `U64BE`/bigint coercion limitation. Writing pre-encoded bytes
 * verbatim under the same tag byte, instead of asking micro-ordinals to re-derive them from a JS
 * object, sidesteps that limitation. Readers must extract this tag's bytes the same raw way (see
 * `rawMetadataPerEnvelope` in `./content-validation.ts`) rather than through
 * `Inscription.tags.metadata`, which still round-trips through that limited decoder.
 */
export function metadataTagChunks(bytes: Uint8Array): [Uint8Array, Uint8Array][] {
  const tag = new Uint8Array([METADATA_TAG]);
  const chunks: [Uint8Array, Uint8Array][] = [];
  for (let i = 0; i < bytes.length; i += MAX_SCRIPT_BYTE_LENGTH)
    chunks.push([tag, bytes.subarray(i, i + MAX_SCRIPT_BYTE_LENGTH)]);
  return chunks;
}

/**
 * Extract the raw (pre-CBOR-decode) bytes of the metadata tag for each sequential inscription
 * envelope in a script, without invoking any CBOR decoding — so the result is byte-identical
 * to what any raw Ordinals indexer would report for `/r/metadata/:id`, never subject to a
 * canonical-re-encoding mismatch against semantically-equal but differently-encoded CBOR.
 *
 * Also the write-side escape hatch from micro-ordinals' own CBOR encoder, which cannot encode a
 * JS `number` in `[2^32, 2^53)` (see `./ordinals-tags.ts`'s `metadataTagChunks`): callers
 * that build the metadata tag from pre-encoded CBOR bytes must read it back the same raw way,
 * never through `Inscription.tags.metadata`, whose micro-ordinals CBOR decode is not this
 * codebase's concern to keep exactly correct for every representable value.
 *
 * Only valid once `parseInscriptions(script, true)` has already returned a defined result for
 * this same script: strict mode guarantees every envelope is non-cursed, sequential, and starts
 * immediately after the leading `<pubkey> CHECKSIG` prefix, so this can walk those same
 * boundaries directly (envelope `n`'s payload starts right after envelope `n-1`'s `ENDIF`) without
 * re-deriving cursed/stutter detection itself. Mirrors ord's stable, publicly documented envelope
 * format (`OP_FALSE OP_IF "ord" [tag,data]* OP_0 [body-chunks]* OP_ENDIF`), not an internal
 * micro-ordinals implementation detail, so it does not depend on that library's non-public API.
 */
export function rawMetadataPerEnvelope(script: ScriptType, count: number): (Uint8Array | undefined)[] {
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
