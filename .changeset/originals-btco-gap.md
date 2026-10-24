---
'@originals/vh': minor
'@originals/sdk': patch
---

An entry after the anchor that this verifier accepted before stays accepted when a later read finds a gap in its did:btco signer's history before it (an unread inscription on the DID's sat, or a tip read below it); `anchoring.gaps` states each one with where the signer's history stops (`establishedBefore`), and the report gives the reason `signer-history-gap`. The exception holds only when the head reached chains to the retained head (`retain.original`); an entry not accepted before stays `later-inscription-unverifiable` (P9.15; originals-spec #51, open at `b96841c2e`; PROVISIONAL until it merges).
