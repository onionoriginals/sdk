---
"@originals/sdk": minor
---

Fee preview + confirm for did:btco appends (#407 phase 4). Once an asset reaches
did:btco (the final layer) every authorship append is a mandatory, paid Bitcoin
inscription with no hosted fallback — phase 4 makes that cost visible up front and
consented to.

- `LifecycleManager.estimateAppendCost(asset, appendKind, opts?)` — a non-mutating
  quote for the NEXT btco append, returning `{ satoshis, feeRate, vbytes,
  contentBytes }`. It sizes the actual payload (`opts.content` / the in-flight new
  media for `'update'`, the reinscribed DID doc for `'rotate'`) and reuses the same
  fee-rate source and `MAX_REASONABLE_FEE_RATE` cap as the real inscribe path, so
  the quote tracks reality. Zero side effects — no signing, appending, or
  inscription. Throws `ORD_PROVIDER_REQUIRED` without an ordinalsProvider.
- `inscribeConfirm` gate — a per-call option on `addResourceVersion` and a config
  default on `OriginalsConfig`. `'now'` (default) is the phase-3 behavior (inscribe
  immediately). A callback is awaited with the estimate BEFORE any log mutation:
  `true` proceeds; `false` cleanly ABORTS the whole append — no event appended,
  nothing inscribed, the asset left byte-identical (abort-before-mutate). A declined
  append throws `PROVENANCE_APPEND_DECLINED` and emits the new `cel:inscribe-declined`
  event; a subsequent append still works (no poisoned state).

No defer/re-anchor path: btco is the final layer with no hosted fallback, so the
only control is proceed-and-pay or abort. Off-btco (did:cel/did:webvh) appends are
unaffected — they inscribe nothing, so the gate is a no-op.
