---
"@originals/cel": major
"@originals/sdk": patch
---

**`PeerCelManager`, `WebVHCelManager`, and `BtcoCelManager` are no longer exported from the `@originals/cel` package root** (#597).

These pre-CEL-3 layer managers predate the CEL 3 profile and are retained only for the previous-format lifecycle and its regression tests; they are not a compatibility path for CEL 3 / SDK 3.0. Exporting them from the package root advertised them as the canonical writer, and each had a documented way to report a migration as complete while dropping artifacts a fresh process needs to resolve or recover the identity.

- Import them from `@originals/cel/legacy` instead of `@originals/cel`.
- `@originals/cel/v3` and `@originals/sdk/cel` (which re-exports it) are unaffected and remain the supported CEL API.
- `@originals/sdk`'s own retained previous-format lifecycle (`LifecycleManager`, the legacy `cel` CLI) now imports these managers from `@originals/cel/legacy`; this is an internal change with no effect on any `@originals/sdk` public export.
