---
"@originals/sdk": patch
---

**Hosted web publication now reports missing historical resource bytes and adapter URL mismatches as their own specific errors, never as the retryable `ASSET_WEB_PUBLISH_INCOMPLETE`** (#739).

`HostedAssets.publish()` previously wrapped its own resource and URL validation errors as retryable upload failures. Resource completeness is now checked in both `prepare()` and `publish()` before any write. Only failures thrown by `storage.putObject()` receive the retryable `ASSET_WEB_PUBLISH_INCOMPLETE` wrapper and retained prepared publication, including adapter-thrown `StructuredError` or `CelError` values. The SDK's resource and URL checks preserve their specific error codes.
