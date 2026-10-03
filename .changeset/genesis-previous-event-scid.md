---
"@originals/cel": major
"@originals/sdk": major
---

New genesis events carry a self-certifying history identifier in `previousEvent`.
Derive the SCID from the full JCS genesis template with that position set to
`"{SCID}"`, using CEL's existing SHA-256 multihash and base64url multibase.
Verify it independently before accepting the genesis. The `ni:` asset ID wraps
this commitment; subsequent event links still hash the final published event.
Historical signed genesis events without `previousEvent` retain their identities.

`signEvent` now fills an absent or placeholder genesis `previousEvent` before
signing. Callers must use the returned event when hashing or checking proofs,
and derive history identity with `deriveAssetId` instead of `eventDigest`.
`deriveScid` and `verifyScid` are available from the CEL profile exports.
