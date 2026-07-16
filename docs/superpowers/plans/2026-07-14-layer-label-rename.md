# Plan: layer-label rename — did:cel genesis reports `'did:cel'`

Spec: `docs/superpowers/specs/2026-07-14-layer-label-rename-design.md`
(did:cel epic — Phase 4, sub-project 4 of 5).

## Task 1 — type + `determineCurrentLayer` + `validTransitions` (+ test)

- **Test first** (`tests/unit/lifecycle/`): a `createAsset` (did:cel genesis) asset
  reports `currentLayer === 'did:cel'`; a legacy `did:peer`-constructed asset still
  reports `'did:peer'`; `migrate('did:webvh')` from a did:cel asset does NOT throw
  (validTransitions has the key).
- `src/types/common.ts` — `LayerType` gains `'did:cel'`.
- `src/lifecycle/OriginalsAsset.ts`
  - `determineCurrentLayer`: `did:cel:` → `'did:cel'` (was `'did:peer'`); drop stale
    "synonym" comment; keep `did:peer:` → `'did:peer'`.
  - `validTransitions` (in `migrate`): add `'did:cel': ['did:webvh','did:btco']`.
- Adding `'did:cel'` to `LayerType` makes every `Record<LayerType, LayerType[]>`
  literal a compile error until it gets the key — so the second `validTransitions`
  copy in `LifecycleManager.validateMigration` (~3328) also gains the key.

## Task 2 — forced ripples from the flipped genesis label

A freshly `createAsset`'d asset now reports `'did:cel'`, so genesis-layer gates that
hard-coded `'did:peer'` must also accept `'did:cel'` (spec §4: publish + inscribe must
succeed from a did:cel asset):
- `LifecycleManager.publishToWeb` gate (~1052) — accept `'did:cel'` OR legacy `'did:peer'`.
- `LifecycleManager.inscribeOnBitcoin` gate (~1904) — accept `'did:cel'` alongside
  `'did:webvh'`/`'did:peer'`.
- `LifecycleManager.recordMigration` from-layer (~1201) — use the dynamic `priorLayer`
  (already captured) so the metric matches the `asset:migrated` event + provenance.

Fold / restore (spec touch points):
- `src/lifecycle/replayProvenance.ts` — genesis-with-controller folds
  `currentLayer: 'did:cel'`; widen `ReplayedProvenance.currentLayer` union; fix JSDoc.
- `src/lifecycle/LifecycleManager.buildRestoredProvenance` — layer seed `'did:peer'` → `'did:cel'`.
- `src/playground/repl.ts` — publish gate accepts either genesis form; fix message.

**Frozen by spec §3 non-goals ("No change to … credentials"):** the `ResourceMigrated`
credential's `fromLayer: 'did:peer' as const` (~1672) and its test stay as-is.

**Fixtures:** run the full suite + grep; flip only assertions that describe a
*did:cel-genesis* asset's layer / migration-from (e.g. `currentLayer).toBe('did:peer')`,
`migrations[0].from).toBe('did:peer')`, `asset:migrated` `fromLayer`). Do NOT touch
did:peer-as-DID-method parsing, hand-built did:peer assets, credential assertions, or
direct `MetricsCollector` unit tests.

## Task 3 — changeset

`.changeset/layer-label-rename.md` (`@originals/sdk` patch).

## Verify
`bun run build` → `bun test` (0 fail) → `bunx tsc --noEmit` clean. One opus reviewer
pass over the whole diff before PR.
