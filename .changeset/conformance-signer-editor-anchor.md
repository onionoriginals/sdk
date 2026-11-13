---
'@originals/vh': patch
'@originals/sdk': patch
---

Two fixes found while closing section 12 rows against originals-spec PR 59
(`a3ffdc1`):

- `@originals/vh`: an editor entry that changes the `anchor` member is
  outside every grant (`EDITOR_AUTHOR_ONLY`, `outside-grant`), as a change of
  aliases or grants is. Before, one whose state was otherwise valid, as before
  the anchoring entry, was rejected as `STATE_MOVE_BEFORE_ANCHOR` instead. A
  move entry is the author's (P9.28, P5.16; C12-267).
- `@originals/sdk`: `keySigner` refuses input that is not a well-formed
  Originals entry (P5.11; C12-302): an entry with members other than
  `versionId`, `versionTime`, `parameters` and `state`, or one that already
  carries a proof; a `versionTime` that is not P14.2's; parameters other than
  P14.1 allows, or a null parameter value; and a state with undefined
  members, a malformed author or editor reference, asset or resource
  descriptor, an alias of another DID method, or transitions that do not name
  the resource's version (P14.4–P14.6). Before, it signed such entries.
