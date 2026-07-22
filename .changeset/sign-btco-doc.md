---
"@originals/sdk": patch
---

Sign the inscribed did:btco document (#442). The on-chain did:btco doc is now signed by the current controller's Ed25519 key (`eddsa-jcs-2022`) at inscribe + reinscribe time, making it self-authenticating — consistent with did:cel events and did:webvh docs, which were already signed. This completes #402's competitor authentication: an honest cross-sat legit-dupe of a did:cel is now detected (the earlier anchoring authenticates against the log's controller key) instead of being silently dropped. Backward-compatible: resolvers that predate the proof ignore it and still cross-check the `#cel` anchor + verification method; the `#cel` head and bitcoin witness commit to the CEL event/head (not the doc), so they're unaffected.
