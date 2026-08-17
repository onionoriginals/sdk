---
"@originals/landing": patch
---

Let the demo revise an asset after creating it — a real signed `update` event appended to its event log.

Once an asset exists, a **Revise artwork** control regenerates the SVG and **Commit update** calls `asset.addResourceVersion(...)`, which appends a signed `update` event chaining the new bytes to the version before them. Revisions stack, and each one shows up in the Event log panel alongside `create` and `migrate` — the chain visibly grows rather than just the preview image changing.

Revising is offered at `did:cel` only, and that is the point rather than a limitation: genesis is the protocol's private drafting layer, so an update there is free, offline, and nothing is hosted yet. After publishing, the SDK has no re-publish-resources API, so a `did:webvh` update would append an event naming a `toHash` whose bytes the origin does not serve; after inscription an update is a paid on-chain append. Both are refused with a stated reason instead of silently allowed.

While a regenerated preview is uncommitted it is badged `not in the log yet`, Publish is disabled (publishing then would publish bytes other than the ones on screen), and a Discard control restores the committed artwork.

Also fixes a latent bug this surfaced: `DemoAssetState` was read out of `asset.resources` **by index**, but `addResourceVersion` *appends* a new version rather than replacing the old one — so the Resource tab and the `/me` summary hash would have stayed pinned to genesis after any revision. The snapshot now selects the newest version of each logical resource by id, and reports `resource.version`.
