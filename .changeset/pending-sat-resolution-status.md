---
"@originals/cel": minor
"@originals/sdk": minor
---

Bitcoin sat resolution distinguishes "not confirmed yet" from "nothing here." When
every publication `resolveSat` observes for a sat is still unconfirmed — nothing
has reached the snapshot's confirmation depth yet — it now reports a distinct
`status: 'pending'` result (carrying the unconfirmed publication ids in `pending`)
instead of `not-found`. `not-found` continues to mean confirmed data was inspected
and no valid boundary was found in it; a sat with no observed publications at all,
or with confirmed-but-invalid ones, still reports `not-found`.

At the SDK layer, `sdk.did.resolveDIDWithMetadata()` surfaces the same
`didResolutionMetadata.status: 'pending'` and the unconfirmed ids on
`didDocumentMetadata.pending`, without throwing. `sdk.did.resolveDID()` treats
`pending` like every other inconclusive status and throws
`ASSET_RESOLUTION_INCOMPLETE`, rather than returning `null` as it previously did
for this case — a caller of the throwing method can no longer mistake "just
broadcast, awaiting its first confirmation" for a confirmed absence.

Progresses the remaining "immediacy hardening" increment noted on #407: a
provider that can already report unconfirmed publications (`confirmed: false`)
is now resolved gracefully instead of colliding with `not-found`. Provider-side
discovery of unconfirmed/mempool publications remains out of scope for this
change; production providers currently only enumerate confirmed inscriptions.
