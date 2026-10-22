---
'@originals/sdk': minor
'@originals/vh': minor
---

Anchored Originals check each did:vh or did:webvh signer against the newest version of its DID the verifier knows of (PROVISIONAL, open originals-spec #47 at 2be62b982; P7.8, P9.15). An entry inscribed after that version is checked against it, not reported as incomplete identity evidence; an entry naming a version with no verified copy is incomplete identity evidence. `assetFreshness.status` is `anchored` for a log Bitcoin decided, and `validAsOf.signers` states each version relied on with `obtainedAt` and `source`. The SDK uses configured or stored signer evidence in place of a package's or host's when it extends it. Anchoring does not require did:btco signers.
