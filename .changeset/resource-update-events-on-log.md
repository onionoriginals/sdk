---
"@originals/sdk": minor
---

Resource versions are now signed CEL `update` log events instead of advisory
envelope metadata. `OriginalsAsset.addResourceVersion` is now **async** and
appends a signed `update` event (via a controller signer bound by
`LifecycleManager`), degrading with `cel:append-skipped` when no signing key is
available. `verifyEventLog` gains a resource-update branch that checks
per-resourceId hash continuity (seeded from genesis) and derives the new content
hash inline, so a buyer can verify every post-genesis version offline.

**BREAKING:** `addResourceVersion` returns a `Promise<AssetResource>` (await it),
and the advisory `AssetEnvelope.unverified.resourceUpdates` field is removed —
`serialize()` no longer emits it and `loadAsset` folds resource versions from the
verified log. Regenerate any persisted envelopes that carried it.
