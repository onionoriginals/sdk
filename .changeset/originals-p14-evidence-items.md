---
'@originals/sdk': minor
'@originals/landing': patch
---

Evidence manifests follow P14.10: each missing item has exactly `{ kind: "resource", resource, version, digest, versionId }` or `{ kind: "identity", did, role }` with `role` (`author` | `editor`) required (`MissingItem` makes `role` non-optional; anything else is `EVIDENCE_MANIFEST`). The landing host lists each signer DID history it does not hold as an identity item instead of judging completeness from resources alone. ZIP archive names are limited to 255 UTF-8 bytes (was UTF-16 code units) for reading and writing.
