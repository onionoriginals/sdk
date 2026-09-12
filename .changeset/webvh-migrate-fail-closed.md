---
"@originals/cel": major
"@originals/sdk": patch
---

`WebVHCelManager.migrate()` (the legacy CEL 1 layer manager retained for
previous-format compatibility) minted a `did:webvh:{domain}:{id}` identifier
locally, with no SCID and no genuine WebVH version history — no conforming
did:webvh resolver could resolve the result. `migrate()` now fails closed with
a descriptive error unless the caller sets
`acknowledgeNonConformantIdentifier: true` in its `WebVHCelConfig`,
acknowledging the identifier is not spec conformant. `OriginalsCel`'s `webvh`
config accepts the same field. Real WebVH publication should go through the
SDK's actual WebVH creation/hosting path instead of this legacy layer manager.

The internal, unpublished `originals-cel migrate --to webvh` CLI command
(`packages/sdk/src/cel/cli/migrate.ts`) now passes the acknowledgment
explicitly and prints a warning that its output is not independently
resolvable.
