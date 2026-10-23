---
'@originals/sdk': minor
'@originals/vh': minor
'@originals/landing': minor
---

Wire format per section 14 of the Originals spec (originals-spec #48, merged at master 1039c471c; PROVISIONAL). BREAKING: evidence packages and hosted snapshots keep signer DID histories under `signers/<hex sha256 of the DID>/` (`signerPath`, replacing `authorPath`) and carry no `asset/did-witness.json`, since asset logs have no witnesses (P9.8); the old `authors/` directory and an asset witness file are rejected (`EVIDENCE_LAYOUT`), with no legacy reading. `verifyOriginal` drops `witnessFile`, `EvidenceContents` drops `witness` and `StoredOriginal`/`CommitUpdate` drop `witness`. An entry's size is the UTF-8 byte length of its stored line without the line feed, at most 65,536 (P7.7, P14.13), in the log engine, the hosted retrieval plan and SDK commits, which fail with `limit-exceeded`. Hosted retrieval caps one resource at 64 MiB (`FETCH_LIMITS.maxResourceBytes`, `RetrievalLimits.maxResourceBytes`, P8.5), separately from the 16 MiB log-file cap. The landing's hosted layout follows, and the First Light example package is regenerated.
