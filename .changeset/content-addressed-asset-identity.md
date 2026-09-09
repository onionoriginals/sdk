---
"@originals/sdk": major
"@originals/cel": major
---

Name Originals with a canonical RFC 6920 `ni:///sha-256;` URI derived from the
unchanged SHA-256 of the canonical genesis event. `asset.id` and `state.assetId`
use this identity; newly serialized asset envelopes use version 4 and `assetId`.
Retain strict reading of version-3 envelopes and the former application-specific
`did:cel` alias, without changing signed history, hosted paths or inscriptions.
The CEL wire format remains version 3. See the SDK 4 migration guide.
