---
"@originals/sdk": patch
---

Fix `HostedAssets.publish()` wrapping `LocalStorageAdapter`'s deterministic `STORAGE_DOMAIN_MISMATCH`/`STORAGE_PATH_TRAVERSAL` rejections as the retryable `ASSET_WEB_PUBLISH_INCOMPLETE`, misdirecting callers into retrying a prepared publication that can never succeed against the same misconfigured adapter (#903).
