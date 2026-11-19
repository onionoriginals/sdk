---
'@originals/vh': minor
'@originals/sdk': minor
'@originals/host': patch
'@originals/code': patch
---

Signer sets (plan 050 W1; owner decision of 19 November 2026, reversing S8).
An Original can be governed by a set of DIDs with a threshold instead of one
author. Single-author Originals are unchanged, byte for byte. The rule IDs
(P5.19–P5.23) and member names are PROVISIONAL until the originals-spec pull
request assigns them.

- `@originals/vh`: the asset's optional `authors: {threshold, dids}`
  (`checkAuthors`, `ORIGINALS_LIMITS.authors` = 32). An entry's `author` is an
  array of signer references exactly when its asset has `authors`, with one
  proof per signer in the same order. Genesis is signed by every member; an
  author entry by the parent's threshold of the parent's members plus every
  added member; a single-author Original converts when the author and every
  new member sign. P5.8 holds per identity; P7.9 currency and P9.15 at an
  inscription hold by threshold. The derived DID document's `controller` is
  the member array. Builders take `authors` and `sign: EntrySigner[]`;
  `cosignEntry` and `finalizeEntry` collect proofs in any order. The report
  adds `signedBy` and `identityEvidence.authors`; for a set Original the
  single-author `identityEvidence` fields are null.
  `EntryState.author` is now `AuthorRef | AuthorRef[]`: use `authorRefsOf`
  or `signersOf` to read it.
- `@originals/sdk`: `create({ authors: { threshold, members }, signers })`,
  and `edit`, `deactivate`, `publish`, `anchor` and `reconcile` take a set
  Original's signer references and `signers`. A draft flow for signers who
  are not all present: `prepare*`, `cosign(draft, signer)`, then
  `commitDraft(draft)` (or `finalizeDraft` for a shared host). Each signer is
  shown the entry as itself, with `summary.signers` and `summary.authors`.
  Evidence packages carry every signing member's DID history.
- `@originals/host`: shared-host saves check every signer of a set entry, and
  a member's account may save.
- `@originals/code`: code Originals stay single-author until the code profile
  moves onto signer sets (plan 050 §5, step 3): a set Original as a repo or
  branch is refused (`SIGNER_SET_UNSUPPORTED`), never read as one author.
