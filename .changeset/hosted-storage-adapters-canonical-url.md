---
"@originals/sdk": patch
---

Fix hosted publication (`publishToWeb`/`prepareWebPublication`) failing with
`ASSET_STORAGE_URL` for both shipped `StorageAdapter` implementations (#780).
`HostedAssets.publish()` requires every write to land at exactly
`https://${domain}/${path}`, but `MemoryStorageAdapter` returns an opaque
`mem://` locator and `LocalStorageAdapter`'s default multi-tenant `baseUrl`
mode appended the domain as its own path segment, duplicating it when
`baseUrl` already pointed at that domain's own origin — so neither adapter
could ever satisfy hosted publication out of the box.

Add `HostedMemoryStorageAdapter`, an in-memory adapter whose `putObject()`
asserts the canonical hosted URL, for tests and local development. Add an
`originDomain` option to `LocalStorageAdapterOptions` that treats `baseUrl`
as exactly one domain's public origin (no repeated domain segment); every
call for a different domain throws `STORAGE_DOMAIN_MISMATCH` rather than
silently mapping it onto the wrong advertised origin. `MemoryStorageAdapter`
itself is unchanged, since its `mem://` locator remains correct for its
other, non-hosted uses.
