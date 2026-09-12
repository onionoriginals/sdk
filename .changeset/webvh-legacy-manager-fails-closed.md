---
"@originals/cel": major
---

**`WebVHCelManager.migrate()` (the legacy pre-CEL-3 layer manager) now fails closed by default** instead of silently minting a did:webvh-labeled identifier that is not conformant with the did:webvh method (#603).

`WebVHCelManager` constructs `did:webvh:{domain}:{idPart}` locally with no SCID and no genuine WebVH version history; an independent did:webvh resolver can reject or misinterpret that identifier. This class predates the did:webvh method's current specification and is retained only for the previous-format lifecycle and its regression tests (see `docs/history/previous-sdk/CLAUDE.md`) — it is not a compatibility path for CEL 3 / SDK 3.0.

- `migrate()` now throws unless `config.acknowledgeNonConformantId` is set to `true`, explicitly acknowledging the retained legacy, non-conformant path.
- `OriginalsCel.migrate(log, 'webvh', options)` accepts the same flag via `options.acknowledgeNonConformantId` (in addition to `config.webvh.acknowledgeNonConformantId` at construction time).
- Real did:webvh identifiers should come from the SDK's `WebVHManager` (`sdk.did.createDIDWebVH()`), which is unaffected.
- The legacy `originals-cel` CLI's internal `migrate --to webvh` path (not the published `originals-cel` binary, which is `@originals/sdk/v3/cli.ts`) now sets this flag itself and prints a warning explaining the non-conformant identifier.
