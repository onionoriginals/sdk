# Originals protocol specs — governing manifest

This is the normative index for the Originals asset protocol in this
repository. It names the pinned documents that govern protocol behavior and
marks everything else as historical.

## Governing: the Originals Protocol on VH-Log

The SDK is being rebuilt on the Originals Protocol. That protocol replaces the
CEL 3 design outright: each Original is a `did:vh` log under the Originals
did:vh extension, signed by its author's DID. The delivery plan is
[`plans/011-originals-vh-replacement.md`](../plans/011-originals-vh-replacement.md).
The CEL 3 code and documents were deleted in its PR 5.

| Document | Pin | Governs |
| --- | --- | --- |
| [Originals Protocol](https://github.com/aviarytech/originals-spec/tree/a432aa67529cd86b4ab38d97cc91963be82acbc3/spec) ([rendered](https://aviarytech.github.io/originals-spec/)) | `aviarytech/originals-spec@a432aa67529cd86b4ab38d97cc91963be82acbc3` (branch `q15-bitcoin-representation`), Editor's Draft 0.1 | Asset state, author binding, editors, identity continuity, operations, evidence packages, hosting, anchoring and ownership. Rules are cited by ID (for example P5.3). |
| Originals Protocol pull requests in the pinned stack | [#34](https://github.com/aviarytech/originals-spec/pull/34) `7072e1f8` only Bitcoin settles a fork (Q5) · [#35](https://github.com/aviarytech/originals-spec/pull/35) `4b945a4e` author keys are ordinary assertionMethod keys (Q6) · [#36](https://github.com/aviarytech/originals-spec/pull/36) `a432aa67` anchoring and the Bitcoin representation (Q15) · [#42](https://github.com/aviarytech/originals-spec/pull/42) did:btco version order and anchoring claims (merged into #36) · [#43](https://github.com/aviarytech/originals-spec/pull/43) scoped editors, shared-host saves and signer identity continuity (merged into #36 through #42) | #34–#36 are stacked and still open against `master`; #42 and #43 are merged into that stack, and `a432aa6` is #36's head with both. The pin moves to `master` only when #34–#36 merge. |
| [VH-Log](https://github.com/swcurran/VH-Log/tree/f2f9fda2d8dae26b717ab54163169350c7182233/spec) | `swcurran/VH-Log@f2f9fda2d8dae26b717ab54163169350c7182233` | Log entries, SCID, entry hashes, parameters, proofs, witnesses, watchers, resolution and retrieval. |
| VH-Log pull requests, treated as merged | [#1](https://github.com/swcurran/VH-Log/pull/1) `a3e3627e` witness verification of candidates · [#2](https://github.com/swcurran/VH-Log/pull/2) `0d5eb134` authoritative source · [#3](https://github.com/swcurran/VH-Log/pull/3) `3bcd0acb` additional cryptosuites · [#8](https://github.com/swcurran/VH-Log/pull/8) `3770b574` versionTime precision · [#9](https://github.com/swcurran/VH-Log/pull/9) `5552a668` non-HTTPS locations · [#10](https://github.com/swcurran/VH-Log/pull/10) `1867a2b1` alternative encodings · [#11](https://github.com/swcurran/VH-Log/pull/11) `7bae699a` keys from a controller | The specialisation hooks the Originals extension uses, and (#1) how witnesses verify a candidate entry. |
| [did:vh](https://github.com/swcurran/didvh/tree/e0b7cbad27d7b2274057251f85687e133329b5a9/spec) | `swcurran/didvh@e0b7cbad27d7b2274057251f85687e133329b5a9` | The `did:vh:<SCID>` identifier, `src`, DID URLs, resolution options and errors. |
| did:vh pull request, treated as merged | [#3](https://github.com/swcurran/didvh/pull/3) `b3e7a56d` extensions | Lets the Originals extension define its own state, parameters and `src` kinds. |
| [did:webvh on VH-Log (experimental)](https://github.com/decentralized-identity/didwebvh/tree/deef9cf12b9543475a1df70322c362876dc89a58/spec-exp) | `decentralized-identity/didwebvh@deef9cf1` (PR 302), method value `did:webvh:1.0` | Author DIDs and an Original's web alias. Logs written by `didwebvh-ts` (did:webvh 1.0) must verify under it. |
| [Data Integrity BIP340 Cryptosuite](https://dcdpr.github.io/data-integrity-schnorr-secp256k1/) | v0.1 draft | `bip340-jcs-2025`. Its draft inconsistencies are recorded as S6 in the plan. |
| [Data Integrity EdDSA Cryptosuites](https://www.w3.org/TR/vc-di-eddsa/) | W3C Recommendation | `eddsa-jcs-2022`. |

The SDK baseline cited by the Originals spec is `onionoriginals/sdk@00fc683`.

### Provisional choices

The spec leaves the asset state schema, the `originals:1.0` method values, the
entry field names and digest encoding, the evidence package format and the
Bitcoin representation open (D1, D4, D6). Section 2 of the plan records the
provisional choices this repository makes. Code that depends on one is marked
`PROVISIONAL` and cites the decision. A provisional choice is not a published
test vector, and nothing built on one supports an interoperability claim.

### Spec findings

Section 4 of the plan lists the places where the pinned documents are
ambiguous or conflict (S1–S8). Where a finding blocks implementation, work on
that rule stops until the spec is corrected. Code never silently diverges from
the pinned text.

The owner decisions that departed from the earlier pin are now in the pinned
stack, so none is a departure any more:
- Only Bitcoin settles a fork (S1, Q5): originals-spec PR #34, P6.6 and P9.16.
- Author keys are ordinary `assertionMethod` keys (S8, Q6): PR #35, P5.3 and
  P5.11.
- Asset logs use no witnesses (S9, Q14): PR #33, P9.8 and P9.9.

Code that cites one of these decisions cites the spec rule as well.

## Conformance evidence

[`originals-conformance.json`](originals-conformance.json) registers every row
of the Originals spec's section 12 matrix under a stable ID, together with its
position in the pinned table and the delivery phase that covers it. A row
counts as covered only when a test cites its ID. Until then it stays `todo`.

IDs are kept across re-pins, so they need not equal table positions. At
`a432aa6` the table has 139 rows:
- Rows 1–91 keep their earlier IDs (row 41 is C12-44, row 57 is C12-59). PRs
  #34–#36 removed the three abandonment-declaration rows that were
  `not-applicable` (C12-24, C12-25, C12-37) and added ten rows; those take the
  freed IDs in table order: row 50 is C12-24, row 83 is C12-25, row 84 is
  C12-37, and rows 85–91 are C12-85 to C12-91.
- Rows 92–112 (PR #42) and 113–139 (PR #43) are C12-92 to C12-139.

Positive checkpoints come with positive and negative fixtures, pinned
decisions and a dependency inventory. Fixtures, dry runs and disposable regtest
do not establish public-host or mainnet behavior.

## Historical / non-normative

None of the documents below states a requirement for the current protocol. No
Originals were issued under these formats, so no conversion, migration or
legacy verification path exists for them.

- The CEL 3 (`originals/cel/3`) documents were deleted with the code that
  implemented them in plan 011 PR 5: `originals-asset-identity.md`,
  `originals-cel-v3-profile.md`, `originals-cel-v3-profile.proposed.md`,
  `originals-cel-v3.schema.json`, `originals-cel-v3-authority.md`,
  `btco-inscription-shape.md` and `did-cel-method.md`. Their last versions are
  at [`onionoriginals/sdk@00fc683`](https://github.com/onionoriginals/sdk/tree/00fc683d0aa7f746904a14fa1f88336f09711ff5/specs).
- [`gap-analysis.md`](gap-analysis.md) — an earlier CEL comparison.
- [`../ORIGINALS_PROTOCOL_SPECIFICATION.md`](../ORIGINALS_PROTOCOL_SPECIFICATION.md) —
  a pointer to the original v1.0 draft, also deleted.

[`specs/auth/`](auth/) documents the separate `@originals/auth` package API
surface. It is not part of the asset protocol contract indexed here.
