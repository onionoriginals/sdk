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
`SIGNATURE_CACHE_ENTRIES` (8192) results, dropping the oldest first;
`clearSignatureCache()` empties it. `checkSignature(key, data, signature)` is
exported.

With 100 versions of a 680 KB resource, an edit drops from 1710 ms to 728 ms
and `get` from 720 ms to 373 ms (Bun, `packages/sdk/scripts/bench-originals.ts`).
