---
"@originals/cel": patch
"@originals/sdk": patch
---

**did:webvh domain authoring and hosted publication now canonicalize (trim + lowercase + host/port validate) the caller's `domain` instead of using it verbatim** (#722, #761, #764).

Three related defects shared one root cause: nothing normalized `domain` before it reached DID construction or a binding comparison.

- `sdk.did.createDIDWebVH`, `createDIDOriginal`, and `updateDIDOriginal` accepted a padded-but-nonblank domain (e.g. `"  example.com  "`) and minted a permanent `did:webvh` with literal whitespace embedded in the identifier — unresolvable once published (#764).
- `lifecycle.publishToWeb`/`prepareWebPublication` rejected a valid mixed-case domain (e.g. `"Example.com"`) with a confusing low-level `CEL_DID` error surfacing from deep inside CEL history verification, instead of a clear domain-specific error or simply normalizing and succeeding (#722).
- Republishing an already-hosted asset rejected a same-host domain that only differed in letter case (e.g. `"Example.com"` vs. the stored `"example.com"`) with `ASSET_WEBVH_BINDING`, since the comparison was a raw case-sensitive string match against the always-lower-cased stored host (#761).

`@originals/cel/v3` (and `@originals/sdk/cel`) export `canonicalizeWebVHDomain`, which trims, lower-cases and validates a WebVH host[:port] and returns its WHATWG `URL#host` spelling (default `:443` dropped, port leading zeros removed). It shares its host checks with `parseAssetAlias`. `HostedAssets.prepare()` (strict: fully qualified DNS hosts only) and `DIDManager`'s `requireWebVHDomain()` (identity seams `createDIDWebVH`, `migrateToDIDWebVH`, `createDIDOriginal`, `updateDIDOriginal`; also admits `localhost[:port]`) both use it, and use that single canonical value for DID construction, method-log storage, and any existing-binding comparison.

A missing/blank domain still throws `WEBVH_DOMAIN_REQUIRED`. Any other unusable domain fails at the seam, before signing, with `CelError` `INVALID_DOMAIN` (IPs, single-label hosts, `localhost` for assets, bad ports) or `CEL_WEBVH_IDNA` (Unicode/punycode), instead of minting broken output, an uncoded didwebvh-ts error, or a much later `CEL_DID` failure. A valid mixed-case, padded or explicit-port domain succeeds and is normalized: republishing with the same `example.com:443` or `example.com:08080` input now succeeds (previously the first publish minted `%3A443`/`%3A8080` while storage used `URL#host`, so the republish failed `ASSET_WEBVH_BINDING`), and `createDIDWebVH({ domain: "example.com:443" })` mints a portless DID. Identity seams now reject single-label hosts and IPs that `createDIDWebVH`/`createDIDOriginal` previously minted or failed uncoded. Republishing to a genuinely different host is still rejected with `ASSET_WEBVH_BINDING`.
