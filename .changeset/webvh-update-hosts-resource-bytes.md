---
"@originals/sdk": minor
---

`addResourceVersion` now hosts the new version's bytes when the asset is published, so a `did:webvh` asset can be updated without its log out-running what the origin serves.

Recording a new resource version appends a signed `update` event carrying the new `toHash`. For an asset bound to a `did:webvh` that hash implies a resource URL — but nothing ever wrote the bytes there: `publishResources` runs only inside `publishToWeb`. Updating a published asset therefore produced a signed, verifying log that named a file the origin answered with 404. In practice that made post-publish updates unusable, which is why callers were left doing revisions only at `did:cel`.

The update path now writes the new bytes to exactly the key `publishToWeb` would have used — `{domain}/{userPath}/resources/{multibase(hash)}` — and emits the usual `resource:published` event. The derivation is shared with `publishResources` rather than duplicated, so the two cannot drift. Earlier versions stay hosted at their own content-addressed keys, so old URLs keep resolving.

Hosting runs **before** the append, mirroring the `inscribeConfirm` gate's abort-before-mutate rule: if the bytes cannot be hosted, `addResourceVersion` throws `STORAGE_REQUIRED` with the log untouched and no version pushed in memory. The reverse ordering has no clean recovery — the event would already be signed into the chain — whereas the only cost of a later append failure is one unreferenced object at a content-addressed key.

Unpublished (`did:cel`) assets are unaffected: there is nothing hosted, so nothing to write.
