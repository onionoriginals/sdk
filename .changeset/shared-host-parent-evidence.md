---
'@originals/sdk': minor
'@originals/host': minor
---

Shared-host saves carry a child Original's parent evidence (P5.24–P5.27,
P7.1, P14.10; originals-spec #66). Before this a host refused every entry of
a child Original as incomplete, because the submission carried no parent log.

- `@originals/sdk`: `Submission.parents` (`[{ did, log }]`, nearest first)
  holds each parent's log through the highest pin, as a package carries it,
  and `identities` adds the parents' signers' DID histories. `submit` fills
  both from the store; `encodeSubmission` sends `parents` only for a child.
  `retrieveHosted` and `loadPublished` read a hosted child's
  `parents/<sha256(did)>/did.jsonl` files and the parents' signers.
- `@originals/host`: the submit route parses `parents` (at most 8, the
  nesting limit, 8 MiB each; PROVISIONAL) and verifies the entry with the
  parent log it holds or a submitted one that extends it, which it then
  stores. A diverging parent log is refused (`parent_evidence_conflict`), a
  parent the child does not name too (`parent_not_named`). Without the
  parent's log through the pin the entry is refused as incomplete
  (`PARENT_EVIDENCE_MISSING`, `PARENT_VERSION_MISSING`), never accepted; an
  entry relying on an inherited grant the held parent log has revoked is
  refused as historically authorized only (P5.26). An editor named by a
  grant in a hosted parent log may call. The hosted layout gains
  `parents/<64 hex>/did.jsonl`, which an owner's upload may only extend
  (`parent_log_not_extending`). The identity bound rises to 128 to cover
  signer sets and parents' signers.
