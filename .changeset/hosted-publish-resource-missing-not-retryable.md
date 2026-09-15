---
"@originals/sdk": patch
---

**Hosted web publication now reports missing historical resource bytes and adapter URL mismatches as their own specific errors, never as the retryable `ASSET_WEB_PUBLISH_INCOMPLETE`** (#739).

`HostedAssets.publish()` checked resource completeness inside the same `try` block used to catch genuine storage-adapter I/O failures, so its `catch` unconditionally rewrapped a permanent `ASSET_RESOURCE_MISSING` defect (and a deterministic `ASSET_STORAGE_URL` mismatch) as "Hosted publication incomplete; retry this same prepared publication" — misdirecting callers who pattern-match on the specific code into a futile retry loop, since no retry can make missing bytes appear. The completeness check now runs before any write, in both `prepare()` and `publish()`, and the storage-failure `catch` only wraps causes that are not already a `StructuredError`/`CelError`.
