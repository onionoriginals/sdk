---
'@originals/sdk': minor
'@originals/vh': minor
---

Anchored Originals check each did:vh or did:webvh signer against the newest version of its DID the verifier knows of (originals-spec #47, merged at master 1039c471c; P7.8, P9.15). An entry inscribed after that version is checked against it, not reported as incomplete identity evidence; an entry before or at the anchor naming a version with no verified copy is incomplete identity evidence; after the anchor it is reported in `anchoring.unverifiable` (`later-inscription-unverifiable`) and never downgrades the accepted head (P9.12), or is `invalid-entry` (`AUTHOR_VERSION_NOT_IN_HISTORY`) when it names a verified version number under another id. `assetFreshness.status` is `anchored` for a log Bitcoin decided, and `validAsOf.signers` states each version relied on with `obtainedAt` and `source`. The SDK uses the newest of a package's or host's, configured and stored signer evidence, compared by verified versionIds; evidence that diverges is an identity fork. Anchoring does not require did:btco signers.
