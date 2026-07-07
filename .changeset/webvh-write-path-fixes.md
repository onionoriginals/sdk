---
"@originals/sdk": patch
---

Fix the did:webvh write paths to match the options didwebvh-ts actually consumes: `updateDIDWebVH` now translates the merged document into the named update options instead of passing an ignored `doc` (every update was a signed no-op, #338); key rotation and recovery carry forward all non-signing verification methods with their keyAgreement/capability relationships instead of wiping them, and enforce Ed25519 on the new update key (#339); the internal key-pair create/update/rotate paths publish the signing verification method as `#key-0` so the authorized `authentication`/`assertionMethod` fragments reference a VM that exists and third-party proof-purpose verification succeeds (#334). Update fields didwebvh-ts cannot express are now rejected loudly instead of silently dropped.
