---
"@originals/sdk": major
"@originals/cel": major
---

**BREAKING: legacy compatibility paths are removed — the protocol starts fresh.** There is no legacy data to support, so the transitional read/write paths are gone rather than maintained:

- **`transfer` events are rejected anywhere, in any shape** (`@originals/cel`). The v0/v1 distinction and the pre-anchor v0 read path are deleted: ownership is the sat, moved by a Bitcoin transaction, never a log event, and no v0 log exists to read. Any log carrying a `transfer` entry fails verification.
- **Genesis lineage is `data.controller` only.** The classification and custody folds (`classifyLogEntries`, `beginCustodyFold`, the landing's custody view) no longer fall back to legacy `data.creator`/`data.did` or the create proof's VM; a genesis without `controller` has no lineage, so nothing can make a post-anchor authenticity claim on such a log. The `genesisLineageDids` helper (added in this same release cycle) is removed.
- **Resource URLs are multibase-multihash only** (`@originals/sdk`). The raw-sha256 legacy segment ("ud…") is never written: the dual-write and the `legacyResourceUrlCompat` config flag are removed, publish/update write exactly one key per resource version, and `parseResourcePathSegment` is deleted (nothing reads segments back — the canonical segment IS the key). The landing host serves exact keys with no alternate-form fallback.
- **`classifyLogEntries` agrees with the verifier on rejected entries**: a post-anchor non-`update` entry is classed `unattributed` regardless of lineage — the display fold never labels an entry "creator" that the verifier rejects.
