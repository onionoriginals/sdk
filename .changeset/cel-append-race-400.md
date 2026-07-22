---
"@originals/sdk": patch
---

fix: unify the per-asset CEL-log lock so `addResourceVersion` and lifecycle
appends can't clobber each other (#400)

Per-asset CEL appends were serialized by two mutually-invisible locks:
`OriginalsAsset.#appendChain` (for `addResourceVersion`) and
`LifecycleManager.inFlightAssets` (for publish/inscribe/rotate/authorize). A
concurrent `addResourceVersion` and a lifecycle op could interleave across
await points and clobber each other's signed append (an event silently
dropped, or a stale-chained event that fails verification).

Fix: `OriginalsAsset` exposes a `runExclusive()` backed by the existing
`#appendChain` mutex — now the SOLE per-asset CEL lock — and every lifecycle
log-mutating op runs its append span (including rollback) through it, taken
after the non-blocking `inFlightAssets` guard (no lock cycle; guard still
throws OPERATION_IN_PROGRESS for concurrent same-asset lifecycle ops).
