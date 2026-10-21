---
'@originals/sdk': minor
'@originals/vh': minor
---

Content availability and signer identity continuity (Originals spec a432aa6). Missing resource bytes, current or historical, no longer fail verification: they are reported as unavailable content in `resources` and `current` excludes them; supplied bytes that fail their digest still fail (P7.3, P7.4, P9.18). `loadPublished().verified` and the `originals verify` command follow. A did:webvh author that moves under did:webvh portability keeps its genesis DID as its identity (P5.14): author binding checks the verification method against the DID document `id` at the named version, histories must verify from the identity DID's genesis with the same SCID, and `alsoKnownAs`, another SCID, redirects or a method change never count. The SDK's new `identityFetch` option retrieves a moved identity's log from the location in the latest entry's verification method (no redirects); identity freshness gains the PROVISIONAL value `retrieved`, and `AuthorDidEvidence` gains `retrievedFrom`.
