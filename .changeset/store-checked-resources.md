---
'@originals/vh': minor
'@originals/sdk': minor
---

Stop re-hashing resource bytes the store already checked when it stored them.

- `verifyOriginal` takes `checked(digest) → size | undefined`: held resource
  versions whose bytes were checked against their digest when stored (P4.3)
  and have not changed since. Each such version is reported `verified` when
  that size matches its descriptor and `mismatch` otherwise, exactly as if
  its bytes had been supplied. Supplied bytes and bytes from an anchoring sat
  take precedence and are still hashed.
- `OriginalsStore.checkedResource?(digest)` is optional. A store may
  implement it only if its bytes cannot change outside it.
  - `MemoryStore` hashes bytes when they are put and reports only those that
    matched. It keeps real copies (also of a Node `Buffer`, whose `slice`
    would share the caller's memory) and hands out only copies, so they never
    change.
  - `FileStore` does not implement it: a file can change with no change to
    its size, times or inode (a shared writable mapping), so no cheap check
    proves it unchanged. Its bytes are read and hashed on every verification,
    with native SHA-256.
  - The SDK passes checked sizes to verification instead of reading and
    hashing every stored version on every `get`, `prepareEdit` and `sign`.

Owner decision, 9 November 2026: bytes checked when stored count as checked.
Reports are the same as from a store without the capability. Together with
the native SHA-256 and signature-cache changes, an edit at 100 versions of a
680 KB resource drops from 1710 ms to 31 ms in Bun, and from 682 ms to 24 ms
in headless Chromium.
