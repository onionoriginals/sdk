---
'@originals/vh': minor
'@originals/sdk': minor
'@originals/landing': patch
---

Signer DID freshness follows the owner decision of 23 Oct 2026 (P7.8, P5.14; originals-spec #51, open at `3f5a15ea6`; PROVISIONAL until it merges): a log obtained at a location establishes freshness only when the DID's own witnesses approve its latest version and that version's `id` names the location. `Freshness` is now `"established" | "not-established" | "stale"` (`"retrieved"` is gone: retrieval alone establishes nothing). `identityEvidence.obtained` and each editor's `obtained` state `{ location, obtainedAt, source, latestVersionId, witnessed }`, `validAsOf.signers[]` carry `location`, and `AuthorVersion.witnessed` is set from the DID log's witness proofs. `describeFreshness(did, evidence)` states in plain words where and when the history was obtained and, unless freshness is established, that the DID may have a newer version (for example one that removes a key) that the verifier has not seen; the `originals verify` text output and the landing's example show it.
