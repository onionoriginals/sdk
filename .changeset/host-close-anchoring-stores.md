---
'@originals/host': minor
---

Stop stranding anchored Originals' stores across deploys.

- `createOriginalsAnchoring` gains `close()`: it waits for each Original's
  queued work, then closes every store the process opened, removing their
  `.lock` files. Later calls answer 503 `shutting_down`. Previously the stores
  stayed open until `process.exit`, and the next container on the same volume
  (another hostname) could never break their locks: every open of that
  Original then failed with `STORE_LOCKED`.
- A store that cannot be opened is now a 503 refusal (`status_unavailable` or
  `submit_unavailable`, with the code, no server path) from `status`,
  `submit` and `recorded`, instead of a thrown error the app served as a 500.
  In `sweep` it counts as one failure and the pass goes on to the next
  Original, instead of ending the pass.
- `releaseOnExit(lock, { close, timeoutMs })` runs `close` (bounded, default
  5s) before releasing the instance lock. Without options it behaves as before.
- New `breakForeignStoreLocks(lock, dataDir)`: with the instance lock held,
  removes FileStore locks recorded by another host, for locks a SIGKILL or a
  crash still leaves behind.
