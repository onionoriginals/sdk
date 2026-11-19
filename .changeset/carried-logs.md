---
'@originals/vh': minor
'@originals/sdk': minor
---

Carried logs and the P14.13 entry limit, built to originals-spec PR 64
(`940c6d4`, open), which keeps both after the owner withdrew EVM anchoring
on 18 November 2026. Bitcoin is the only anchor.

- Carried logs (P7.11–P7.16, P14.14–P14.17; PROVISIONAL): `readCarriedFile`,
  `writeCarriedFile`, `carriedDisclosure`, `locateCarrier` and
  `removeCarrier` in `@originals/vh/originals`, and `carry`,
  `carriedDisclosure`, `readCarried` and `importCarried` on the SDK. A file
  carries its Original's log in a trailer, a text block in a comment or a
  JSON member. A reader resolves signer DIDs only on an explicit
  `resolveSigners` opt-in, which applies to that single read: there is no
  standing opt-in, and importing never counts as one (P7.13). A carried log
  with no anchoring entry is a historical checkpoint; an anchored Original's
  state comes from its sat, never from the carried copy (P7.14). The
  text-block writer places a block only where the version's own parser reads
  it as a comment, and refuses a syntax it has no parser for (`no-parser`,
  P14.16).
- Breaking: the 65,536-byte entry limit is measured over the entry's JCS form
  in UTF-8 in every format (P14.13), not over the stored line. `verifyLog` no
  longer takes `lineBytes`, and `parseLog` no longer records line sizes. A
  stored line within 65,536 bytes whose JCS form is over it is now rejected.
- `@originals/sdk`: the SDK refuses to sign an entry over the limit (P14.13).
  One over it even with the shortest proof fails with `ENTRY_TOO_LARGE`
  (`limit-exceeded`) before the signer is asked; before, it was signed and
  then refused (`COMMIT_VERIFICATION_FAILED`), which still happens only when
  the actual proof takes it over.
- `@originals/sdk`: a package is a copy not read from the anchor (P7.1,
  P7.14). `load` of an anchored Original's package without `bitcoin`
  evidence reports `bitcoin-evidence-missing` and verifies at most the
  entries before the first anchoring entry; before, it verified the whole
  log. `LoadedEvidence.notCheckedAgainstAnchor` lists the anchoring entry and
  later ones. `import`, and the Bitcoin writer's own check of its committed
  log, still verify the copy whole, never current without the anchor (P7.5,
  P9.18).
