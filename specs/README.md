# Originals protocol specs — governing manifest

This is the normative index for the Originals asset protocol in this
repository. It names the pinned documents that govern protocol behavior and
marks everything else as historical.

## Governing: the Originals Protocol on VH-Log

The SDK is being rebuilt on the Originals Protocol. That protocol replaces the
CEL 3 design outright: each Original is a `did:vh` log under the Originals
did:vh extension, signed by its author's DID. The delivery plan is
[`plans/011-originals-vh-replacement.md`](../plans/011-originals-vh-replacement.md).
Until its phases land, parts of the code still implement CEL 3. That code is
scheduled for deletion and is not a compatibility target.

| Document | Pin | Governs |
| --- | --- | --- |
| [Originals Protocol](https://github.com/aviarytech/originals-spec/tree/d64fdbe4aef3d12e26109e7eeab28da569169e05/spec) ([rendered](https://aviarytech.github.io/originals-spec/)) | `aviarytech/originals-spec@d64fdbe4aef3d12e26109e7eeab28da569169e05`, Editor's Draft 0.1 | Asset state, author binding, operations, evidence packages, hosting, witnesses, anchoring and ownership. Rules are cited by ID (for example P5.3). |
| [VH-Log](https://github.com/swcurran/VH-Log/tree/f2f9fda2d8dae26b717ab54163169350c7182233/spec) | `swcurran/VH-Log@f2f9fda2d8dae26b717ab54163169350c7182233` | Log entries, SCID, entry hashes, parameters, proofs, witnesses, watchers, resolution and retrieval. |
| VH-Log pull requests, treated as merged | [#2](https://github.com/swcurran/VH-Log/pull/2) `0d5eb134` authoritative source · [#3](https://github.com/swcurran/VH-Log/pull/3) `3bcd0acb` additional cryptosuites · [#8](https://github.com/swcurran/VH-Log/pull/8) `3770b574` versionTime precision · [#9](https://github.com/swcurran/VH-Log/pull/9) `5552a668` non-HTTPS locations · [#10](https://github.com/swcurran/VH-Log/pull/10) `1867a2b1` alternative encodings · [#11](https://github.com/swcurran/VH-Log/pull/11) `7bae699a` keys from a controller | The specialisation hooks the Originals extension uses. |
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
ambiguous or conflict (S1–S6). Where a finding blocks implementation, work on
that rule stops until the spec is corrected. Code never silently diverges from
the pinned text.

## Conformance evidence

[`originals-conformance.json`](originals-conformance.json) registers every row
of the Originals spec's section 12 matrix under a stable ID (`C12-01` to
`C12-93`), together with the delivery phase that covers it. A row counts as
covered only when a test cites its ID. Until then it stays `todo`.

Positive checkpoints come with positive and negative fixtures, pinned
decisions and a dependency inventory. Fixtures, dry runs and disposable regtest
do not establish public-host or mainnet behavior.

## Historical / non-normative

None of the documents below states a requirement for the current protocol. No
Originals were issued under these formats, so no conversion, migration or
legacy verification path exists for them. The CEL 3 documents are deleted
together with the code that implements them.

- [`originals-asset-identity.md`](originals-asset-identity.md),
  [`originals-cel-v3-profile.md`](originals-cel-v3-profile.md),
  [`originals-cel-v3.schema.json`](originals-cel-v3.schema.json),
  [`originals-cel-v3-authority.md`](originals-cel-v3-authority.md) and
  [`btco-inscription-shape.md`](btco-inscription-shape.md) — the CEL 3
  (`originals/cel/3`) contract that the Originals Protocol replaces.
- [`originals-cel-v3-profile.proposed.md`](originals-cel-v3-profile.proposed.md),
  [`did-cel-method.md`](did-cel-method.md) and
  [`gap-analysis.md`](gap-analysis.md) — earlier CEL drafts and comparisons.
- [`../ORIGINALS_PROTOCOL_SPECIFICATION.md`](../ORIGINALS_PROTOCOL_SPECIFICATION.md) —
  the original v1.0 draft.

[`specs/auth/`](auth/) documents the separate `@originals/auth` package API
surface. It is not part of the asset protocol contract indexed here.
