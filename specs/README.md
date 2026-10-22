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
| [Originals Protocol](https://github.com/aviarytech/originals-spec/tree/051049d8b/spec) ([rendered](https://aviarytech.github.io/originals-spec/)) | `aviarytech/originals-spec@051049d8b` (`master`), Editor's Draft 0.1 | Asset state, author binding, editors, identity continuity, operations, evidence packages, hosting, anchoring and ownership. Rules are cited by ID (for example P5.3). `master` includes #34–#36 (with #42 and #43), #45 (editors, shared-host saves and identity continuity recorded as owner decisions) and #46 (an unanchored Original is never current; key custody is out of scope). |
| Open proposals implemented provisionally | [#47](https://github.com/aviarytech/originals-spec/pull/47) head `2be62b982`: for an anchored Original a did:vh or did:webvh signer is checked against the newest version of its DID the verifier knows of; anchoring does not require did:btco (owner decisions of 21 October 2026; rows 51 and 70) · [#48](https://github.com/aviarytech/originals-spec/pull/48) head `1f90e43bc`, stacked on #47: section 14, the provisional wire format P14.1–P14.13, recorded from SDK revision `1b3cabdd`, and rows 146–153 | Not merged. Code that depends on one is marked `PROVISIONAL` with the pull request and its head, and the pin stays at `master` until they merge. |
| [VH-Log](https://github.com/swcurran/VH-Log/tree/f2f9fda2d8dae26b717ab54163169350c7182233/spec) | `swcurran/VH-Log@f2f9fda2d8dae26b717ab54163169350c7182233` | Log entries, SCID, entry hashes, parameters, proofs, witnesses, watchers, resolution and retrieval. |
| VH-Log pull requests, treated as merged | [#1](https://github.com/swcurran/VH-Log/pull/1) `a3e3627e` witness verification of candidates · [#2](https://github.com/swcurran/VH-Log/pull/2) `0d5eb134` authoritative source · [#3](https://github.com/swcurran/VH-Log/pull/3) `3bcd0acb` additional cryptosuites · [#8](https://github.com/swcurran/VH-Log/pull/8) `3770b574` versionTime precision · [#9](https://github.com/swcurran/VH-Log/pull/9) `5552a668` non-HTTPS locations · [#10](https://github.com/swcurran/VH-Log/pull/10) `1867a2b1` alternative encodings · [#11](https://github.com/swcurran/VH-Log/pull/11) `7bae699a` keys from a controller | The specialisation hooks the Originals extension uses, and (#1) how witnesses verify a candidate entry. |
| [did:vh](https://github.com/swcurran/didvh/tree/e0b7cbad27d7b2274057251f85687e133329b5a9/spec) | `swcurran/didvh@e0b7cbad27d7b2274057251f85687e133329b5a9` | The `did:vh:<SCID>` identifier, `src`, DID URLs, resolution options and errors. |
| did:vh pull request, treated as merged | [#3](https://github.com/swcurran/didvh/pull/3) `b3e7a56d` extensions | Lets the Originals extension define its own state, parameters and `src` kinds. |
| [did:webvh on VH-Log (experimental)](https://github.com/decentralized-identity/didwebvh/tree/deef9cf12b9543475a1df70322c362876dc89a58/spec-exp) | `decentralized-identity/didwebvh@deef9cf1` (PR 302), method value `did:webvh:1.0` | Author DIDs and an Original's web alias. Logs written by `didwebvh-ts` (did:webvh 1.0) must verify under it. |
| [Data Integrity BIP340 Cryptosuite](https://dcdpr.github.io/data-integrity-schnorr-secp256k1/) | v0.1 draft | `bip340-jcs-2025`. Its draft inconsistencies are recorded as S6 in the plan. |
| [Data Integrity EdDSA Cryptosuites](https://www.w3.org/TR/vc-di-eddsa/) | W3C Recommendation | `eddsa-jcs-2022`. |

The SDK baseline cited by the Originals spec is `onionoriginals/sdk@00fc683`.

### Provisional choices

The pinned spec leaves the asset state schema, the `originals:1.0` method
values, the entry field names and digest encoding, the evidence package format
and the Bitcoin representation open (D1, D4, D6). Open PR #48 records the
SDK's choices as section 14 for review; where it asks the SDK to change (the
`signers/` package directory, no asset witness file, entry size in UTF-8
bytes, a 64 MiB resource fetch limit), the SDK follows it, PROVISIONAL. Section 2 of the plan records the
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

IDs are kept across re-pins, so they need not equal table positions. Rows
were mapped to the pinned table by their text:
- At `a432aa6` the table had 139 rows: rows 1–91 kept their earlier IDs (row
  41 is C12-44, row 57 is C12-59); PRs #34–#36 removed three
  abandonment-declaration rows (C12-24, C12-25, C12-37) and their IDs were
  reused in table order for row 50 (C12-24), 83 (C12-25) and 84 (C12-37);
  rows 85–139 are C12-85 to C12-139.
- At `master` `051049d8b` the table has 145 rows. Rows 1–139 are the same
  rows at the same positions, so they keep their IDs. Six are reworded: row
  22 (C12-22, an old prefix is valid as of its checkpoint, never current,
  P7.10), 45 (C12-48, deactivation reported and entries historically
  authorized only, P7.9), 54 (C12-56, "the most recent earlier author
  entry"), 118 (C12-118), 122 (C12-122) and 129 (C12-129, the anchored
  cases). Rows 140–145 are new: C12-140 to C12-145. No row was removed, so
  none is retired; a retired ID would never be reused.
- Rows 146–153 come from the open PR #48 and are C12-146 to C12-153. They
  carry `proposal` and are PROVISIONAL until #48 merges.

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
