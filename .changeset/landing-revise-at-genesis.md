---
"@originals/landing": patch
---

Let the demo revise an asset after creating it — a real signed `update` event appended to its event log.

Once an asset exists, a **Revise artwork** control regenerates the SVG and **Commit update** calls `asset.addResourceVersion(...)`, which appends a signed `update` event chaining the new bytes to the version before them. Revisions stack, and each one shows up in the Event log panel alongside `create` and `migrate` — the chain visibly grows rather than just the preview image changing.

Revising works at `did:cel` (free and offline, nothing hosted yet) and at `did:webvh`: the SDK now hosts the new bytes before it signs, so a published revision is fetchable at the URL its DID implies and earlier versions stay resolvable. An **inscribed** asset is refused with a stated reason — that append writes a new inscription on its satoshi, which is a paid on-chain operation rather than a demo click.

While a regenerated preview is uncommitted it is badged `not in the log yet`, Publish is disabled (publishing then would publish bytes other than the ones on screen), and a Discard control restores the committed artwork. Revising is modelled as a flag rather than a lifecycle phase, since it is authorship *at* the current layer and never moves the asset on; the pipeline holds its current stage instead of lighting up the layer the asset hasn't reached.

Also fixes a latent bug this surfaced: `DemoAssetState` was read out of `asset.resources` **by index**, but `addResourceVersion` *appends* a new version rather than replacing the old one — so the Resource tab and the `/me` summary hash would have stayed pinned to genesis after any revision. The snapshot now selects the newest version of each logical resource by id, and reports `resource.version`.
