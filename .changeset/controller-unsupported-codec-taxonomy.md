---
"@originals/cel": patch
---

**`decodeController` now reports a recognized-but-out-of-profile did:key codec (e.g. secp256k1, bls12_381-g2) as `unsupported` instead of `invalid`** (#721).

`specs/originals-cel-v3-profile.md` distinguishes `invalid` (malformed/failed validation) from `unsupported` (a recognized CCG feature/version/suite outside this application's profile). `decodeController` (`packages/cel/src/v3/primitives.ts`) previously reported both cases as `invalid`: a well-formed `did:key` using a real, recognized multicodec outside this profile's three supported algorithms (Ed25519, P-256, P-384) — such as secp256k1 or bls12_381-g2, both already recognized elsewhere in this codebase by `packages/cel/src/crypto/Multikey.ts` — was indistinguishable from a genuinely malformed or noncanonical controller.

`decodeController` now checks the decoded codec against a small table of recognized-but-out-of-profile multicodec headers before falling through to the existing malformed/noncanonical check, and throws `CelError("unsupported", "CEL_CONTROLLER", ...)` for those. A structurally malformed, noncanonical, or wholly-unrecognized controller is unaffected and still throws `CelError("invalid", "CEL_CONTROLLER", ...)`.

This is the same taxonomy bug already fixed for the algorithm-mismatch case in `proofs.ts` (#700). Two other call sites originally suspected of the same defect — `profile.ts`'s closed-set `operation.type` switch and `dids.ts`'s `parseAssetAlias` DID-method check — are intentionally left as `invalid`: both validate against this profile's own closed set of Originals-specific values, not a recognized-but-out-of-application CCG feature, so `invalid` is the correct status for them despite their error messages saying "Unsupported".
