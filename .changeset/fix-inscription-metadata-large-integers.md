---
"@originals/sdk": patch
---

**Fixed the default inline Bitcoin publication path permanently failing for a signed CEL history whose metadata contains an integer `>= 2^32`** (#687), while an undocumented `inlineResourceId: null` call for the same asset succeeded.

`checkedContent` (`packages/sdk/src/v3/bitcoin.ts`) and `createCommitTransaction` (`packages/sdk/src/bitcoin/transactions/commit.ts`) built the inscription's Ordinals `metadata` tag by asking micro-ordinals' own CBOR encoder to re-derive it from a plain JS object. That encoder cannot encode a JS `number` in `[2^32, 2^53)` (a `micro-packed` `U64BE`/bigint coercion limitation) and threw `ASSET_INSCRIPTION_METADATA`, permanently blocking the SDK's documented default resource-selection behavior for an otherwise valid, already-signed CEL document — the offending signed event, once in history, could never be removed.

The metadata tag is now written from CEL's own pre-encoded, deterministic CBOR bytes (`encodeDocument(document, "cbor")`), placed verbatim under the inscription's raw `unknown` tag/data pushes rather than asking micro-ordinals to re-derive them, sidestepping that encoder's limitation entirely for every CEL-representable document. Readers (the self-check in `prepare()`, and `validate()`'s check before `publish()` broadcasts) extract the same raw bytes and verify them with CEL's own `parseDocument(..., "cbor")`, rather than through micro-ordinals' `Inscription.tags.metadata`, whose decoder is not relied on to preserve every CEL-representable value.

`inlineResourceId: null` (log-only publication) remains an explicit product choice, not an automatic fallback: the default inline path now succeeds on its own for this input instead of requiring that undocumented workaround.
