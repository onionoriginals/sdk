---
'@originals/vh': minor
'@originals/sdk': patch
'@originals/host': patch
---

Hash resource versions with the platform's native SHA-256.

- `@originals/vh` adds `sha256Async`, `sha256MultihashAsync` and
  `resourceDigestAsync`. They use WebCrypto (`crypto.subtle.digest`) for
  inputs of 16 KiB and up, and noble otherwise or where WebCrypto is missing
  or refuses the input. The digest is SHA-256 either way, so every value is
  byte-identical to `resourceDigest`. The bytes are read when it is called:
  an input WebCrypto hashes is copied first, so changing it afterwards does
  not change the digest.
- `verifyOriginal` checks supplied resource bytes with it (P4.3). Every
  version's bytes are looked up and read before any digest is awaited, so
  reports are unchanged: the same `verified`, `missing` and `mismatch` per
  version and the same reasons.
- `@originals/sdk` hashes new resource versions, packaged bytes, imported
  bytes and `resourceBytes` with it. `prepareCreate` and `prepareEdit` read
  and check their input before awaiting the digest, as before, and keep a
  private copy of the caller's bytes (a real copy, also of a Node `Buffer`). `@originals/host` checks shared-save resources with it.

With 25 versions of a 680 KB resource, an edit drops from 281 ms to 119 ms
and `get` from 135 ms to 59 ms (Bun, `packages/sdk/scripts/bench-originals.ts`).
