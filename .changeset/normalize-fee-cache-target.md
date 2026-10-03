---
"@originals/landing": patch
---

Normalize `/api/btc/fee`'s confirmation-target cache key so the 60s fee cache and single-flight dedupe actually work (#771).

`currentFeeRate()` cached fee estimates keyed by the raw, client-supplied `blocks` number, but `QuickNodeProvider.estimateFee` normalizes that argument to `Math.max(1, Math.floor(blocks))` before making the actual RPC call. Requests whose `blocks` values floor to the same target (e.g. `1`, `1.1`, `1.9999`, `-5`) are functionally identical upstream requests, but each previously got its own cache entry, its own in-flight slot, and its own real QuickNode RPC call — defeating the documented "one estimate per confirmation target per 60s" contract. The success cache (`feeCache`) also had no eviction at all, unlike the adjacent failure cache, so it grew for the life of the process.

- `currentFeeRate` now normalizes `blocks` to the exact provider-side target before any cache/in-flight lookup, so equivalent requests share one cache entry, one in-flight request, and one failure-cache entry.
- The success cache now uses the existing `createExpiringCache` helper (already used for the failure cache) instead of an immortal `Map`, so expired entries are actually swept rather than only shadowed by a timestamp check.
- `POST /api/btc/fee` now rejects a non-finite `blocks` value (e.g. `1e400`, which is valid JSON syntax that overflows to `Infinity`) with `400 bad_request` before any estimator call, instead of letting it reach the estimator.
