# Design: Fee preview + confirm (epic #407, phase 4)

> Fourth increment of epic #407. Phase 3 (#411) made every did:btco authorship
> append a **mandatory, paid** Bitcoin inscription — and that mandate is not a
> choice: once an asset reaches did:btco (the final layer) there is **no webvh
> host to fall back to**, so a btco append must inscribe or not happen at all.
> Phase 4 makes that unavoidable cost **visible up front** (a preview) and
> **consented to** (a confirm gate) — no surprise spends.
>
> **Stacks on #411** (the phase-3 append-inscribe path). Branch off #411 /
> main-after-#411.

## 0. Decision record

- **Preview, not just post-hoc events.** Phase 3 emits `cel:inscribe-cost`
  *after* inscribing. Phase 4 adds a **non-mutating estimate returned to the
  caller BEFORE committing**, extending the existing `LifecycleManager.estimateCost`
  (the "quote-only" did:btco cost path) to cover an append.
- **Control = confirm/cancel, NOT defer.** A btco append cannot fall back to
  hosted/webvh (final layer, no host). So the only control is: see the cost, then
  proceed-and-pay or abort. There is no cheaper-by-deferring path.
- **The cheaper path is a different phase.** The only way to pay *less* on-chain
  is a weaker guarantee — the checkpoint/squash tier — which is its own later
  increment, not this one.
- **No re-anchor / no defer state.** Both assumed a hosted fallback that does not
  exist for btco assets; dropped.

## 1. Preview — `estimateAppendCost`

A non-mutating quote for the *next* btco append:
```
estimateAppendCost(asset, appendKind: 'update' | 'rotate', opts?): Promise<{
  satoshis: number;         // estimated total inscription cost
  feeRate: number;          // the (capped) fee rate used
  vbytes: number;           // estimated tx vsize
  contentBytes: number;     // size of the media/content being inscribed
}>
```
- Reuses `estimateCost`'s fee-oracle + `capEstimatedFeeRate` (same source/cap as
  the real inscribe path, so the quote tracks reality).
- Sizes the actual payload the append would inscribe (new media for an `update`;
  event-only for a `rotate`) so the estimate reflects *this* append.
- Requires the ordinalsProvider (a btco op); throws `ORD_PROVIDER_REQUIRED`
  otherwise. Zero side effects — no signing, no append, no inscription.

## 2. Control — the confirm gate

A knob on the btco append path (`addResourceVersion`/`rotateKey`), via a per-call
option and a config default:
- **`inscribeConfirm: 'now'`** (default, = phase-3 behavior) — inscribe
  immediately, no prompt.
- **`inscribeConfirm: <callback>`** — before inscribing, call
  `await callback(estimate)` (the §1 estimate). If it returns `true`, proceed and
  inscribe. If it returns `false`, **abort the entire append**: no event is
  appended, nothing is inscribed, no partial state — the operation is a clean
  no-op that surfaces a `PROVENANCE_APPEND_DECLINED` result/signal.
- Config-level default `inscribeConfirm` on `OriginalsConfig` sets the policy for
  all btco appends unless a call overrides it.

## 3. Abort semantics (the load-bearing detail)

When the confirm callback returns false, the append is aborted **before** the log
is mutated — the sign+append and the inscription happen together downstream of the
gate, so declining leaves the asset exactly as it was (no orphaned event, no
UNPROVABLE_BASE, no half-inscribed state). The gate sits *before* `appendCelEventAndMaybeInscribe`
(the phase-3 entry point), not between append and inscribe.

## 4. Surfacing / events

- The §1 estimate is **returned** to the caller (and passed to the confirm
  callback) — not only emitted as an event.
- `cel:inscribe-cost` (phase 3) still fires on the actual inscription.
- New `cel:inscribe-declined` signal when a confirm gate aborts an append.

## 5. Boundaries / deferred

- Checkpoint/squash tier (the only *cheaper on-chain* option) — its own phase.
- Secondary-content inscription — its own phase.
- Payment rails / who-pays / wallet integration — out of scope (this is estimate
  + consent, not payments).
- Off-btco appends (did:cel/did:webvh, still free/hosted) — unaffected; the
  preview/confirm apply only to btco appends that actually inscribe.

## 6. Testing spine

- **Preview non-mutating + accurate:** `estimateAppendCost` returns a plausible
  quote and leaves the asset/log/chain untouched; the quote ≈ the actual cost the
  subsequent real append incurs (same fee-rate source).
- **Confirm true:** append proceeds and inscribes normally (phase-3 path).
- **Confirm false → clean abort:** no event appended, nothing inscribed, asset
  unchanged (log head, resources, current media all identical to before);
  `cel:inscribe-declined` fires; a follow-up append still works (no poisoned
  state).
- **Default preserved:** with no `inscribeConfirm` (or `'now'`), btco appends
  behave exactly as phase 3.
- **Provider required:** `estimateAppendCost` without an ordinalsProvider →
  `ORD_PROVIDER_REQUIRED`.
- **Off-btco unaffected:** a did:cel/did:webvh append ignores the gate (no
  inscription, no prompt).

## 7. Changeset

`@originals/sdk` **minor** — `estimateAppendCost` previews a did:btco append's
inscription cost without committing; a per-call / config `inscribeConfirm` gate
lets callers approve or cleanly abort a paid append after seeing the estimate.
Informed consent on the unavoidable cost of appending to a btco asset (#407).
