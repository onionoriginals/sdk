---
'@originals/vh': patch
'@originals/sdk': patch
---

Fixes found while closing section 12 rows:

- `@originals/vh`: an asset state whose `aliases` list the same DID twice is
  rejected (`STATE_ALIASES`, P14.5; C12-299).
- `@originals/sdk`: `keySigner` refuses input that is not a well-formed
  Originals entry (P5.11; C12-302): an entry with members other than
  `versionId`, `versionTime`, `parameters` and `state`, or one that already
  carries a proof; a `versionTime` that is not P14.2's; parameters other than
  P14.1 allows, or a null parameter value; and a state with undefined
  members, a malformed author or editor reference, asset or resource
  descriptor, an alias of another DID method, or transitions that do not name
  the resource's version (P14.4–P14.6). Before, it signed such entries.
- `@originals/sdk`: a did:btco signer's history is read from Bitcoin and is
  never packaged, so a package no longer lists it as a missing item and can
  be complete (P7.1, P14.10; C12-298).
