---
"@originals/sdk": patch
---

**`OriginalsSDK.create({ storageAdapter })` now validates the adapter's shape and no longer silently drops a new-style adapter from `config.storageAdapter`** (#698).

The constructor checked `"putObject" in storageAdapter` before confirming `storageAdapter` was even an object, so a malformed value (e.g. a string) crashed with a raw `TypeError` instead of a structured `CelError` (`SDK_STORAGE_ADAPTER`). Separately, only a legacy-shape adapter (`put`/`get`) was ever copied onto `this.config.storageAdapter` — a pure new-style adapter (`putObject`/`getObject`/`exists`) built the local hosted-publication adapter correctly but was invisible to duck-typed consumers that read `config.storageAdapter` directly (e.g. `DIDManager.readStoredCelLog`), even though the option's declared type accepts either shape. Both shapes are now forwarded.
