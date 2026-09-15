---
"@originals/sdk": patch
---

**`resolveDID`/`resolveDIDWithMetadata` now surface a resolution status for a cross-network or wrong-layer Bitcoin DID instead of throwing** (#695).

`AssetResolver.resolveDID` threw a raw `CelError("invalid", "ASSET_NETWORK")` for a syntactically valid asset alias whose layer/network didn't match the configured provider, contradicting `packages/sdk/V3.md`'s documented contract that `resolveDIDWithMetadata` "surfaces `didResolutionMetadata.status`... without throwing" for every inconclusive case, and leaking that undocumented code past `AssetDIDManager.resolveDID`'s single-error-code (`ASSET_RESOLUTION_INCOMPLETE`) contract. The check now shares the same `identity-mismatch` handling already used by `AssetResolver.check()`: a parsed alias naming the wrong layer or network resolves to `{ didDocument: null, didResolutionMetadata: { status: "identity-mismatch" }, ... }` rather than throwing. A malformed identifier (one that fails to parse at all) still throws, unchanged.
