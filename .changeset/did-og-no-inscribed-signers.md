---
"@originals/sdk": minor
"@originals/vh": minor
---

did:og inscriptions carry no signer DID histories (originals-spec D22).
Inscription metadata is `{entries, part?}`; a legacy `signers` member is
ignored and never used as evidence. did:vh and did:webvh signers of inscribed
entries come from a resolved log in the evidence set and are checked at the
version each entry names: a missing log gives `signer-history-missing` and a
short one `signer-version-missing`, leaving the anchor `undetermined` or the
inscription `unverifiable`, never accepted. `originals-og anchor verify`
fetches the author's `did.jsonl` (no redirects) and supplies it, warns beside
the report when the newest version removes the key or deactivates the DID,
and waits for the required depth at the ord explorer's own tip.
