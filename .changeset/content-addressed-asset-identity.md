---
"@originals/sdk": major
"@originals/cel": major
---

Name Originals with `did:cel:<SCID>` derived from the SHA-256 genesis
commitment. Continue reading the interim `ni:` identity spelling. `asset.id` and `state.assetId`
use this identity; newly serialized asset envelopes use version 4 and `assetId`.
Retain strict reading of version-3 envelopes and the former application-specific
`did:cel` alias, without changing signed history, hosted paths or inscriptions.
The CEL wire format remains version 3. See the SDK 4 migration guide.
