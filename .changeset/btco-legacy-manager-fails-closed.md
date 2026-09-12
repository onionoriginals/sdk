---
"@originals/cel": major
"@originals/sdk": patch
---

**`BtcoCelManager.migrate()` (the legacy pre-CEL-3 layer manager) now fails closed by default** instead of silently inscribing a did:btco document that a fresh process cannot use to recover pre-inscription history (#597).

`BtcoCelManager.migrate()` inscribes a did:btco document whose only anchor is `service[0].serviceEndpoint.headDigestMultibase` — a head digest of the migrate event, not the asset's full CEL boundary history the CEL 3 recovery model needs. A recipient holding just the inscribed document and the bare sat cannot reconstruct pre-inscription history from this writer alone. This class predates the CEL 3 lifecycle and is retained only for the previous-format lifecycle and its regression tests (see `docs/history/previous-sdk/CLAUDE.md`) — it is not a compatibility path for CEL 3 / SDK 3.0.

- `migrate()` now throws a `StructuredError` (`CEL_BTCO_INCOMPLETE_HISTORY`) unless `config.acknowledgeIncompleteHistory` is set to `true`, explicitly acknowledging the retained legacy path.
- Real, fully recoverable Bitcoin publication should come from the SDK's CEL 3 path (`packages/sdk/src/v3/bitcoin.ts` / `hosted.ts`, or `@originals/cel/v3`), which is unaffected.
- `OriginalsCel`'s `btco` config already intersects `BtcoCelConfig`, so `config.btco.acknowledgeIncompleteHistory` threads through automatically.
- The legacy `originals-cel` CLI's internal `migrate --to btco` path (not the published `originals-cel` binary, which is `packages/sdk/src/v3/cli.ts`) now sets this flag itself and prints a warning explaining the incomplete history.

**Breaking:** `BtcoCelManager.migrate()` now throws by default where it previously succeeded; existing callers that knowingly rely on this retained legacy path must pass `{ acknowledgeIncompleteHistory: true }`.
