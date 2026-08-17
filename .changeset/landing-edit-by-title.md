---
"@originals/landing": patch
---

Make editing an Original fluent: change the title and the artwork is regenerated from it.

The title and medium fields were frozen the moment an asset was created, so the only route to a new version was a "Revise artwork" button that shuffled a hidden nonce — new art, but nothing you chose. The form is now the edit surface for the whole life of the asset: retitle it and the preview regenerates live, then **Commit update** signs it into the log. The shuffle button stays as a second route to fresh art. The form locks only while an operation is in flight, or once inscribed (that append costs sats).

Pending-edit detection now compares the artwork **bytes** against the bytes in the log rather than tracking the nonce, so any route to new artwork counts — and typing the title back to its committed value correctly clears the pending state instead of leaving a phantom revision. Discard restores the committed title, medium and artwork together.

Fixes an incoherence in the first pass at this: `metadata.json` embeds the title, the medium **and** the artwork's `sha256`, but only `artwork.svg` was being revised — so after an edit the asset's own metadata described a title and bytes it no longer carried. An edit now revises both resources, and genesis `created` is preserved (it records when the asset was made, not when it was last touched). The metadata blob is built by one shared function for genesis and every revision, so the two shapes cannot drift.

No-op edits stay out of the log: committing without changing anything appends nothing, since `addResourceVersion` refuses a version identical to its predecessor.
