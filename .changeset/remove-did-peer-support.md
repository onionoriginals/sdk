---
"@originals/sdk": major
"@originals/cel": major
---

**BREAKING: did:peer support is removed entirely.** No creation, no resolution, and — unlike earlier releases — no verifier read path. `@aviarytech/did-peer` is no longer a dependency of either package.

- **Verifier (`@originals/cel`)**: a did:peer DID is refused wherever a self-certifying DID is checked — genesis controllers, legacy `data.did` bindings, rotateKey targets, and committed `data.author` values all fail closed (empty key set, never a resolver fallback). Pre-existing logs whose genesis or rotation chain names a did:peer DID **no longer verify**. `validateDID` no longer accepts `did:peer:…` — and now accepts `did:key:…`, the protocol's only self-certifying method.
- **SDK (`@originals/sdk`)**: `DIDManager.resolveDID` returns null for did:peer (unsupported method, no fabricated stub); the credential documentLoader no longer treats did:peer as self-certifying, so legacy did:peer credentials no longer verify (registry fallback is did:key-only); `loadAsset` / `resolveAssetFromSat` refuse any log whose current controller is not a did:key with a clear error, and a post-anchor append under a non-did:key signing VM throws `CEL_APPEND_FAILED` before anything is appended or inscribed.
