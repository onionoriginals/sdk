---
"@originals/sdk": patch
---

**did:webvh domain authoring and hosted publication now canonicalize (trim + lowercase + host/port validate) the caller's `domain` instead of using it verbatim** (#722, #761, #764).

Three related defects shared one root cause: nothing normalized `domain` before it reached DID construction or a binding comparison.

- `sdk.did.createDIDWebVH`, `createDIDOriginal`, and `updateDIDOriginal` accepted a padded-but-nonblank domain (e.g. `"  example.com  "`) and minted a permanent `did:webvh` with literal whitespace embedded in the identifier — unresolvable once published (#764).
- `lifecycle.publishToWeb`/`prepareWebPublication` rejected a valid mixed-case domain (e.g. `"Example.com"`) with a confusing low-level `CEL_DID` error surfacing from deep inside CEL history verification, instead of a clear domain-specific error or simply normalizing and succeeding (#722).
- Republishing an already-hosted asset rejected a same-host domain that only differed in letter case (e.g. `"Example.com"` vs. the stored `"example.com"`) with `ASSET_WEBVH_BINDING`, since the comparison was a raw case-sensitive string match against the always-lower-cased stored host (#761).

`DIDManager`'s `requireWebVHDomain()` and `HostedAssets.prepare()` now both canonicalize a non-blank domain via the existing `validateAndNormalizeDomain()` primitive (already used by the legacy lifecycle manager) and use that single canonical value for DID construction, method-log storage, and any existing-binding comparison. `migrateToDIDWebVH`'s previously hand-rolled duplicate domain validation is replaced by the same shared call.

A missing/blank domain still throws `WEBVH_DOMAIN_REQUIRED`. A malformed-but-nonblank domain (bad host format, invalid port, etc.) now fails immediately at the SDK/hosted seam with a domain-specific `INVALID_DOMAIN` error instead of either minting broken output or surfacing a much later, confusing `CEL_DID` failure. A valid mixed-case or padded domain succeeds and is normalized; republishing to the same host under a different letter case now succeeds, while republishing to a genuinely different host is still rejected with `ASSET_WEBVH_BINDING`.
