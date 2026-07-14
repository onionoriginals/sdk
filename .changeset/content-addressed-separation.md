---
"@originals/sdk": minor
---

Content-addressed separation (epic #407 phase 1): resource-update CEL events now reference content by a signed `toHash` instead of embedding the file bytes. **Breaking to the on-log event shape** — a resource-update `update` event's `data` is now `{ resourceId, contentType, previousVersionHash, toHash, toVersion }` with no `content` field, reversing #401's embed-the-bytes shape.

Content travels as content-addressed blobs alongside a byte-light log: the `serialize()` envelope carries the bytes in its `resources` array (keyed by hash), so offline verification is preserved — `loadAsset` binds `hash(blob) == toHash` (and every envelope resource must match a log-declared hash by resourceId, or it fails closed). The verifier checks only hash-chain continuity on the signed hashes and no longer recomputes `hash(content)` from the event. This shrinks the log so it can be affordably inscribed on Bitcoin in a later phase (#407). Public APIs (`addResourceVersion`, `serialize`, `loadAsset`) are unchanged externally.
