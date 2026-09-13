---
"@originals/sdk": patch
---

`SignetProvider.createInscription` now types its parameters from the shared
`OrdinalsProvider` contract (`data`/`buildContent`/`targetSatoshi`) instead of a
narrower local shape, and rejects deferred content (`buildContent`) or
reinscribing a pinned satoshi (`targetSatoshi`) with a named
`StructuredError('ORD_PROVIDER_UNSUPPORTED', ...)` before assuming an
unconfigured wallet is the reason nothing happened. Static-`data` behavior is
unchanged.
