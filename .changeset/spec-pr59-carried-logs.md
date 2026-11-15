---
'@originals/vh': minor
'@originals/sdk': minor
---

Carried logs and the P14.13 entry limit, built to originals-spec `master`
(`5c42958`, after PR 59 and #63, with the owner decisions of 13 and 14
November 2026).

- Carried logs (P7.11–P7.16, P14.14–P14.17): `readCarriedFile`,
  `writeCarriedFile`, `carriedDisclosure` and `locateCarrier` in
  `@originals/vh/originals`, and `carry`, `readCarried` and `importCarried`
  on the SDK. A reader resolves signer DIDs only on an explicit
  `resolveSigners` opt-in, which applies to that single read: there is no
  standing opt-in, and importing never counts as one (P7.13). The text-block
  writer places a block only where the version's own parser reads it as a
  comment, and refuses a syntax it has no parser for (`no-parser`, P14.16).
- EVM anchoring (P3.9, P9.19–P9.29, P14.18–P14.22) is not in this release
  (owner decision, 14 November 2026). It is built and tested in the
  repository but stays internal until the spec pins an audited anchor
  contract (P14.21): no published entry point of either package exports or
  declares it. An Original whose genesis entry has an `anchor` member
  verifies as unsupported, never invalid (section 14): `history.status`
  `unsupported` with `EVM_NO_ANCHOR_CONTRACT` (`unsupported-profile`), never
  current, through `verifyOriginal`, `get`, `load` and carried-log reads. A
  writer refuses to write one: `create` and the vh builders throw
  `EVM_NO_ANCHOR_CONTRACT`.
- Breaking: the 65,536-byte entry limit is measured over the entry's JCS form
  in UTF-8 in every format (P14.13), not over the stored line. `verifyLog` no
  longer takes `lineBytes`.
