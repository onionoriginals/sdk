---
'@originals/vh': minor
'@originals/sdk': minor
---

After the anchor, an inscription signed by a did:btco whose sat was read in full through it, naming a versionId that is not one of that DID's versions, is `invalid-entry` (`AUTHOR_VERSION_NOT_IN_HISTORY`, P5.13), not `later-inscription-unverifiable`; unverifiable stays for histories that are unavailable or not read through the inscription (P9.15; owner decision, 23 Oct 2026; originals-spec #51, merged at master `19d3e82a0`). The retained anchor lists the inscriptions reported unverifiable (`RetainedAnchor.unverifiable`, kept by both stores); when the head later moves because one of them is resolved, `anchoring.headChange` reports it (see the chain-order changeset for its final shape) with the notice `head-changed`, once, instead of changing the head silently.
