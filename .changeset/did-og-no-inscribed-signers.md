---
"@originals/sdk": minor
"@originals/vh": minor
---

did:og inscriptions carry no signer DID histories (originals-spec D22).
Inscription metadata is `{entries, part?}`; a legacy `signers` member is
ignored and never used as evidence only in a mainnet inscription at or below
block 977,150, and anywhere else makes the metadata invalid. did:vh and did:webvh signers of inscribed
entries come from a resolved log in the evidence set and are checked at the
version each entry names: every supplied log that verifies in full is evidence and
one that fails anywhere is none; a missing log gives `signer-history-missing`,
and logs that do not hold the named version (short, or a fork)
`signer-version-missing`, leaving the anchor `undetermined` or the
inscription `unverifiable`, never accepted. `originals-og anchor verify`
fetches the author's `did.jsonl` (no redirects) and supplies it, warns beside
the report when the newest version removes the key or deactivates the DID,
and waits for the required depth at the ord explorer's own tip.
