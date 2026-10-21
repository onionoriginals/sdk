---
'@originals/vh': minor
---

Anchored editor entries (Originals spec P5.17, P5.18, P9.12, P9.15). An editor entry inscribed on the anchoring sat is checked against the editor DID's state at its inscription time, as an author entry is against the author DID's (versionTime with the named-later-version exception for did:vh and did:webvh, chain order for did:btco), and is ignored with `author-deactivated-at-inscription-time` once the author DID's state at its inscription time is deactivated. Editor entries inscribed by the sat's holder are accepted; only author entries anchor; chain order on the sat decides between an editor entry and the revocation of its grant.
