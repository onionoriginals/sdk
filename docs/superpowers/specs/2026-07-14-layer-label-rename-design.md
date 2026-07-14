# Design: layer-label rename — a did:cel genesis reports `'did:cel'`

> did:cel epic — Phase 4, sub-project 4 of 5. Fixes the misleading lifecycle
> layer label: a did:cel genesis asset currently reports `currentLayer:
> 'did:peer'` (`OriginalsAsset.determineCurrentLayer`, line ~691), a leftover
> from before did:cel replaced did:peer as the genesis layer.

## 0. Decision record

- **Vocabulary:** keep the existing DID-method-named convention (the other
  layers are already `'did:webvh'` / `'did:btco'`). A did:cel genesis reports
  `currentLayer: 'did:cel'`; legacy did:peer assets keep reporting
  `'did:peer'`. No switch to lifecycle-stage names.
- **Legacy:** `'did:peer'` stays a valid layer — did:peer assets still exist and
  must keep working. Its full deprecation is a separate sub-project (5).
- **Back-compat:** hard cutover (nothing released). Fixtures/tests asserting
  `currentLayer === 'did:peer'` for a *did:cel-genesis* asset flip to `'did:cel'`.

## 1. The change

`LayerType` gains `'did:cel'`:

```ts
// src/types/common.ts
export type LayerType = 'did:peer' | 'did:cel' | 'did:webvh' | 'did:btco';
```

A did:cel genesis asset reports `currentLayer: 'did:cel'` instead of the
misleading `'did:peer'`. The label stays method-named, so the axis is
self-describing and consistent across all four values.

## 2. Touch points

- **`src/types/common.ts`** — add `'did:cel'` to the `LayerType` union.
- **`src/lifecycle/OriginalsAsset.ts`**
  - `determineCurrentLayer(didId)` — `did:cel:` → `'did:cel'` (was `'did:peer'`);
    keep `did:peer:` → `'did:peer'`; other branches unchanged. Drop the stale
    "did:cel is the genesis-layer synonym for did:peer" comment (line ~690) — it
    is now a real dedicated layer.
  - `validTransitions` (used by `migrate`) — add
    `'did:cel': ['did:webvh', 'did:btco']`. **Required:** without this key, a
    did:cel asset's `migrate()` throws on an undefined lookup
    (`validTransitions[this.currentLayer]`). Keep the `'did:peer'` entry for
    legacy assets (same targets).
- **`src/lifecycle/replayProvenance.ts`** — the genesis branch (a `create` event
  with `data.controller`) folds `currentLayer: 'did:cel'` (was `'did:peer'`);
  update the `ReplayedProvenance.currentLayer` union to include `'did:cel'`.
- **`src/lifecycle/LifecycleManager.ts`** — `buildRestoredProvenance`'s layer
  seed (`let layer: LayerType = 'did:peer'` ~line 715) becomes `'did:cel'` for
  the did:cel-genesis restore path, so a loaded/folded asset reports `'did:cel'`.
- **`src/playground/repl.ts`** — the publish gate (`if (asset.currentLayer !==
  'did:peer')`) accepts **either** genesis form: allow publish when
  `currentLayer` is `'did:cel'` or legacy `'did:peer'`; adjust the message text.

## 3. Non-goals / unchanged

- No lifecycle-stage renaming of the other layers (`'did:webvh'`/`'did:btco'`
  stay).
- No did:peer removal — legacy did:peer support is untouched here (sub-project 5).
- No change to did:cel derivation, verification, ownership, or credentials.

## 4. Testing spine

- A `createAsset` (did:cel genesis) asset reports `currentLayer === 'did:cel'`.
- A legacy did:peer-constructed asset still reports `currentLayer === 'did:peer'`.
- `migrate('did:webvh')` and the inscribe path succeed from a `'did:cel'` asset
  (validTransitions has the key — no undefined-key throw).
- `loadAsset` / `replayProvenance` of a did:cel genesis yields
  `currentLayer === 'did:cel'`.
- The publish gate accepts a `'did:cel'` asset (and still a legacy `'did:peer'`
  one).
- Regenerate any fixtures/tests asserting `'did:peer'` for a did:cel-genesis
  asset.

## 5. Changeset

`@originals/sdk` **patch** — note the corrected label: `OriginalsAsset.currentLayer`
now returns `'did:cel'` for a did:cel genesis (was `'did:peer'`); `LayerType`
gains `'did:cel'`; legacy did:peer assets unchanged.
