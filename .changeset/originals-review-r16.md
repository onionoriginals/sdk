---
'@originals/sdk': minor
'@originals/vh': minor
---

Signer DID evidence is chosen by verified versionIds, never by bytes: of a package's or host's, the configured and the stored evidence, the one with the newest verified version is used, and its versionId is compared against as retained; evidence that diverges is an identity fork (AUTHOR_DID_FORK, incomplete identity evidence) (P7.8, P7.9; PROVISIONAL originals-spec #47). Entry size is the UTF-8 byte length of the stored line on every path: `verifyLog` takes the stored sizes (`lineBytes`) and entries parsed with `parseLog` carry theirs; an entry with no stored line is measured as its JCS line (P14.13; PROVISIONAL, section 14). `publish`, `hostedFiles` and a shared-host `submit` refuse a resource larger than the 64 MiB fetch cap with `limit-exceeded` `RESOURCE_OVER_FETCH_LIMIT` naming it; `assertHostable` is exported (P8.5, P14.13).
