# Plan: Fee preview + confirm (epic #407, phase 4)

Implements the [phase-4 spec](../specs/2026-07-15-fee-preview-confirm-phase4-design.md).
Stacks on #411 (phase-3 append-inscribe path). Branch `work-fee-preview-phase4`
off `origin/work-per-event-phase3c`.

## Goal

Make the unavoidable on-chain cost of a did:btco authorship append **visible up
front** (a non-mutating preview) and **consented to** (a confirm gate that cleanly
aborts a declined paid append). No defer path — btco is the final layer with no
hosted fallback.

## Key facts established by code reading

- The bound controller appender (`OriginalsAsset.#celAppender`) is reached ONLY
  from `addResourceVersion` with `type: 'update'`. It routes to
  `LifecycleManager.appendCelEventAndMaybeInscribe(asset, type, data)` — the
  phase-3 entry point that (1) `appendCelEventOrSkip` **mutates the log**, then
  (2) `inscribeCelAppend` does the paid broadcast.
- **Critical abort constraint:** in `#addResourceVersionCritical`, after the
  appender returns, `this.resources.push(newResource)` runs **unconditionally**
  (both appended and degraded cases, OriginalsAsset.ts:744). So a declined append
  that merely *returned* would still advance `resources` — NOT byte-identical.
  Therefore decline must **throw** so the throw propagates before line 744 (the
  `pendingHeadMedia` `finally` still clears, log never mutated → clean no-op).
- `bitcoinManager.estimateFeeRate()` (= `resolveFeeRate`) uses the SAME
  feeOracle → ordinalsProvider → `MAX_REASONABLE_FEE_RATE` cap chain as
  `estimateCost` / `capEstimatedFeeRate`, and is exactly what the real inscribe
  path's `emitInscribeCost` already uses (`vsize = ceil(bytes/4)+200`,
  `sats = ceil(feeRate*vsize)`). Mirroring it makes the quote track the actual cost.
- At gate time (before `appendCelEventOrSkip`), the new media for an `update`
  lives in `asset.pendingHeadMedia` (set by `addResourceVersion` before it calls
  the appender). `tryResolveHeadMedia` matches by the LOG head, which has NOT
  advanced yet at gate time, so the gate reads `pendingHeadMedia` directly.

## Steps (commit after each)

1. **Plan** (this file). COMMIT.
2. **Types** (`types/common.ts`): add `AppendKind = 'update' | 'rotate'`,
   `AppendCostEstimate = { satoshis; feeRate; vbytes; contentBytes }`,
   `InscribeConfirm = 'now' | ((e: AppendCostEstimate) => boolean | Promise<boolean>)`;
   add `inscribeConfirm?: InscribeConfirm` to `OriginalsConfig`. COMMIT.
3. **Preview** (`LifecycleManager.estimateAppendCost`): non-mutating quote for the
   next btco append. `ORD_PROVIDER_REQUIRED` without a provider. Sizes the payload
   (opts.content → pendingHeadMedia → head media → btco-doc fallback); fee rate via
   `bitcoinManager.estimateFeeRate()` (respects `opts.feeRate`). COMMIT.
4. **Confirm gate**: extend the appender signature with an `opts?` carrying
   `inscribeConfirm`; thread it from `addResourceVersion(…, opts?)` → `_bindCelAppender`
   binding → `appendCelEventAndMaybeInscribe`. At the TOP of that method (before
   `appendCelEventOrSkip`), when the append WILL inscribe (btco + provider) and the
   effective `inscribeConfirm` (per-call ?? config ?? 'now') is a callback: compute
   the estimate, `await callback(estimate)`; false → emit `cel:inscribe-declined` +
   throw `PROVENANCE_APPEND_DECLINED` (clean no-op, abort-before-mutate). COMMIT.
5. **Event** (`events/types.ts` + `utils/EventLogger.ts`): add
   `cel:inscribe-declined` (interface, union, map, logger config/subscribe/case). COMMIT.
6. **Tests** + `.changeset/fee-preview-confirm-phase4.md` (minor). COMMIT.

## Testing spine (from spec §6)

- Preview non-mutating + accurate; leaves asset/log/chain untouched; quote ≈ real cost.
- Confirm true → phase-3 path proceeds & inscribes.
- Confirm false → clean abort: no event, nothing inscribed, resources/log/media
  identical; `cel:inscribe-declined` fires; a follow-up append still works.
- Default (`'now'`/unset) preserves phase-3 behavior.
- `estimateAppendCost` without provider → `ORD_PROVIDER_REQUIRED`.
- Off-btco append ignores the gate (no inscription, no prompt).

## Security review

One fable reviewer on the gate + preview before PR: confirm `estimateAppendCost`
is truly non-mutating; a false confirm leaves the asset byte-identical (no orphaned
event, no `UNPROVABLE_BASE`, no half-inscribed state) and a later append still
works; the gate sits before mutation (not between append and inscribe); the
estimate can't be used to skip the paid inscription while still appending.
