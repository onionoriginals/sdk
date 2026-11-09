---
'@originals/sdk': minor
---

Partial evidence packages for incremental uploads, built in.

- `package(did, { omitResources: { throughVersion?, digests? } })` leaves out
  the bytes of the first `throughVersion` resource versions and of versions
  whose digest is listed, unless a packaged version names the same bytes. It
  lists each one as a missing resource item, and the manifest says `partial`
  (P7.4, P14.10). The result is byte-identical to the hand-rolled
  read-delete-write of a complete package, but it is never built at full
  size: at 25 versions of 680 KB, 0.7 MB instead of 17 MB, in 140 ms instead
  of 290 ms.
- `import(zip, { requireResources: true })` accepts a partial package only
  when this store already holds every version it leaves out, each matching
  its digest. It refuses packaged bytes that do not match. Both checks cover
  every resource version of the imported log, whatever checkpoint the
  manifest names, and run before anything is stored: `RESOURCES_NOT_HELD`
  (`unavailable-bytes`, with `details.missing`) and
  `RESOURCE_DIGEST_MISMATCH` (`invalid-evidence`).
- `import` of a history this store already holds (`already-current`) or a
  prefix of it (`kept-newer-local`) now keeps the packaged bytes the held log
  names, each only under its matching digest. This is content availability
  only; no verification outcome changes (P7.3).
- `import(zip, { original })` refuses a package for another Original
  (`IMPORT_REJECTED`).
- Leaving bytes out changes nothing else that verifies (P7.3).
- `package` and `import` reject an options value that is not an object,
  unknown option names (own or inherited) and mistyped values such as
  `requireResources: "true"` (`INPUT_INVALID`).
