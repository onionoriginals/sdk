---
"@originals/cel": major
"@originals/sdk": patch
---

**`BtcoCelManager.migrate()` (the legacy pre-CEL-3 layer manager) now fails closed by default instead of silently inscribing a did:btco document that a fresh process cannot use to recover pre-inscription history** (#597).

`BtcoCelManager.migrate()` inscribes a did:btco document that commits only to a head digest of the migrate event, not the asset's full CEL boundary history that the CEL 3 recovery model needs — a recipient holding just the inscribed document and the bare sat cannot reconstruct pre-inscription history from this writer alone. This mirrors the fail-closed guard already applied to the sibling `WebVHCelManager.migrate()` for #603, completing item 5 ("if retained for compatibility, make write methods fail loudly") of the #597 triage.

- `BtcoCelConfig` gains `acknowledgeIncompleteHistory?: boolean` (default unset/`false`). `migrate()` now throws a descriptive error pointing callers at the CEL 3 Bitcoin publication path (`packages/sdk/src/v3/bitcoin.ts` / `hosted.ts`, or `@originals/cel/v3`) unless this is explicitly set to `true`.
- The guard runs after all existing structural validation (empty log, missing create event, wrong source layer, deactivated log), so those error paths are unchanged — only the success path requires acknowledgement.
- `OriginalsCel`'s `btco` config already intersects `BtcoCelConfig`, so the flag threads through automatically via `config.btco.acknowledgeIncompleteHistory`.
- The internal, unpublished `originals-cel migrate --to btco` CLI command (`packages/sdk/src/cel/cli/migrate.ts`) sets the acknowledgment explicitly and warns the operator.

This is a breaking change to `BtcoCelManager`'s default runtime behavior for `@originals/cel`; `@originals/sdk`'s own change is an internal call-site update only (patch).
