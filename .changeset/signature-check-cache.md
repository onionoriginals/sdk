---
'@originals/vh': minor
---

Cache signature checks by their exact inputs.

Verifying a log again (every `get`, `prepareEdit`, `sign`, `load` and
`import` in `@originals/sdk`) re-checked every entry's Ed25519 or BIP340
signature. `verifyProof` now remembers the result of each check, keyed by the
key type, public key, signed bytes and signature. A signature check is a pure
function of those, so the cache returns the result checking again would give,
and verification results are unchanged. The cache holds at most
`SIGNATURE_CACHE_ENTRIES` (8192) results, dropping the oldest first, and only
checks over at most `SIGNATURE_CACHE_MAX_DATA` (128) signed bytes with
signatures up to 64 bytes and keys up to 33 bytes, so a caller cannot make it
hold large messages (every proof's hash data fits). At most a few MiB is
held. `clearSignatureCache()` empties it.

`checkSignature(key, data, signature)` is exported: the raw check
`verifyProof` makes, with the cache. It trusts `key` to come from
`decodeMultikey`, which validates it; `verifyProof` refuses invalid keys
(`MULTIKEY_INVALID`) before it gets that far.

With 100 versions of a 680 KB resource, an edit drops from 1710 ms to 728 ms
and `get` from 720 ms to 373 ms (Bun, `packages/sdk/scripts/bench-originals.ts`).
