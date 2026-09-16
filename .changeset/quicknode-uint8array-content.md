---
"@originals/sdk": patch
---

`QuickNodeProvider` now returns a plain `Uint8Array` for inscription content instead of a Node `Buffer`, matching the documented `Uint8Array` contract on `OrdinalsProvider.getInscriptionById(...).content` and `SatSnapshotReader.content()`. A `Buffer` is structurally a `Uint8Array` subclass, but it overrides observable behavior — notably `JSON.stringify`, which serializes a `Buffer` as `{"type":"Buffer","data":[...]}` instead of the plain-`Uint8Array` shape — so a caller that serializes this content (logging, caching, hashing a serialized envelope) could get a different byte representation than the type promised (#796).
