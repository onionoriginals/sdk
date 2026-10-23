---
'@originals/sdk': minor
'@originals/vh': minor
'@originals/landing': patch
---

The author can add and remove resources (originals-spec #49, master 1039c471c; P4.1, P4.4, P5.15, P5.16, P14.4, P14.5). `edit` adds a resource for a new id (with its `mediaType`), appended after the existing ones at version 1, and removes resources with `remove: [id]` while one remains; `prepareUpdateOriginal` takes the same `resources` and `remove`, and `usedResourceIds`. An editor entry never adds or removes a resource (`outside-grant`, `EDITOR_AUTHOR_ONLY`). A resourceID is never used again in an Original, even after removal (`invalid-evidence`, `STATE_RESOURCE_REUSED`); a removed resource must leave every grant (`STATE_EDITORS`). Transitions give `from: null` for an added resource and `to: null` for a removed one, the resulting resources first and then the removed ones in their previous order. A removed resource's earlier versions stay in reports, packages and hosted snapshots. The signer display names additions and removals. `STATE_RESOURCE_SET` now means only a reordering, an empty resource set or a removal of an unknown id. BREAKING (types): `Transition.to` is `string | null`; `EntryContext` (the VH-Log engine's specialisation context) carries `history`.
