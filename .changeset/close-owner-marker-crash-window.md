---
"@originals/landing": patch
---

Close a crash window in `OriginalsStore.saveBytes` that let a different signed-in user silently overwrite another user's durable hosted DID resource (#690).

`saveBytes` wrote resource bytes, then the content-type sidecar, then the `.owner` ownership marker as three independent, non-atomic writes. A process crash between the bytes write and the owner write left bytes on disk with no owner marker; the ownership check then read a missing marker as "unclaimed," so the next `saveBytes` call for that key from **any** other user passed the check and overwrote the first user's bytes.

- The `.owner` marker is now the sole ownership commit point and is created atomically (write-temp, fsync, exclusive `link`) *before* any resource bytes are written, never after. A crash between the claim and the bytes write leaves a resumable, still-protected in-progress write — never orphaned bytes a stranger can claim.
- If a key's resource bytes exist with no owner marker (e.g. data written before this fix, or disk corruption), the store now fails closed with a new `INCONSISTENT_OWNERSHIP` error (mapped to HTTP 409) for every caller, including the original writer, rather than treating the key as unclaimed.
- Resource bytes, the content-type sidecar, and the per-user JSON index are now all written with the same atomic write-temp/fsync/rename/fsync-dir pattern already used by `inscriptions-store.ts`, instead of a direct `writeFileSync`.
