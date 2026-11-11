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
| [Originals Protocol](https://github.com/aviarytech/originals-spec/tree/3ed0f89/spec) ([rendered](https://aviarytech.github.io/originals-spec/)) | `aviarytech/originals-spec@3ed0f89`, the head of open [PR 59](https://github.com/aviarytech/originals-spec/pull/59) (an experimental branch, not `master`) on `master` `915b726`, Editor's Draft 0.1 | Asset state, author binding, editors, identity continuity, operations, evidence packages, hosting, anchoring and ownership. Rules are cited by ID (for example P5.3). `master` includes #34–#36 (with #42 and #43), #45 (editors, shared-host saves and identity continuity recorded as owner decisions), #46 (an unanchored Original is never current; key custody is out of scope), #47 (for an anchored Original a did:vh or did:webvh signer is checked against the newest version of its DID the verifier knows of; anchoring does not require did:btco), #48 (section 14, the provisional wire format P14.1–P14.13) and #49 (the author can add and remove resources; editors cannot; a resourceID is never reused; P4.1, P4.4, P5.15, P5.16, P14.4, P14.5), #50 (the Bitcoin values and the section 14 limits are decided, with up to 256 resources; P9.5, P9.10, P9.17, P14.13) and #51 (the SDK's open questions of 23 October 2026, as owner decisions: after the anchor chain order decides, so a publication waits while an earlier inscription extending the same head is unverifiable, and every head change is reported; an identity gap affects only the entries that depend on it; freshness is established only by the signer DID's own witnesses or watchers, reported plainly; submitted, not observed, is never pending; the section 14 wire rules P14.2, P14.3, P14.5 and P14.8 and the ZIP writer binding of P14.10 are decided; P5.13, P5.14, P5.15, P7.8, P9.15, P9.18), #52 (section 14's intro says exactly which of its values are decided; no rule or row changes) and #53 (owner decision, 1 November 2026: an Original is exactly one resource, which can have many versions, replacing #49's resource sets; grants are `{did, name, metadata, resource}` and an entry has at most one transition; each inscription's body is the resource version its last entry names, under that version's media type, and its metadata carries the entries as a CBOR array, with metadata and body together at most 350,000 bytes; the SDK tells the author before inscribing what becomes public and permanent; no resource limit; P4.1, P4.4, P5.15, P9.17, P9.18, P14.4–P14.6, P14.9, P14.10, P14.12, P14.13). Originals written under the earlier encoding, including the mainnet acceptance Original of 1 November 2026, are not converted and no longer verify (D1, D7). And #54: inscription metadata carries a non-integer number as the narrowest exact CBOR float, as ord writes it, and a reader accepts any of the three widths, rejecting NaN, infinities, negative zero and magnitudes above 2^53 − 1 (P14.12). `master` `915b726` adds #58: carried logs, a file that carries its Original's log in a trailer, text block or JSON member (P7.11–P7.16, P14.14–P14.17), and EVM anchoring on an anchor contract's token, with did:evm token aliases, trust classes, and move entries up a layer (P3.9, P9.19–P9.29, P14.18–P14.22). PR 59 (not merged) carries both through the older sections and qualifies an EVM anchor's settlement of a fork by the chain's finality and trust class (P6.6, P9.24, P9.27). Both are experimental here; the code that follows them says `EXPERIMENTAL` and cites PR 59. |
| [VH-Log](https://github.com/swcurran/VH-Log/tree/f2f9fda2d8dae26b717ab54163169350c7182233/spec) | `swcurran/VH-Log@f2f9fda2d8dae26b717ab54163169350c7182233` | Log entries, SCID, entry hashes, parameters, proofs, witnesses, watchers, resolution and retrieval. |
| VH-Log pull requests, treated as merged | [#1](https://github.com/swcurran/VH-Log/pull/1) `a3e3627e` witness verification of candidates · [#2](https://github.com/swcurran/VH-Log/pull/2) `0d5eb134` authoritative source · [#3](https://github.com/swcurran/VH-Log/pull/3) `3bcd0acb` additional cryptosuites · [#8](https://github.com/swcurran/VH-Log/pull/8) `3770b574` versionTime precision · [#9](https://github.com/swcurran/VH-Log/pull/9) `5552a668` non-HTTPS locations · [#10](https://github.com/swcurran/VH-Log/pull/10) `1867a2b1` alternative encodings · [#11](https://github.com/swcurran/VH-Log/pull/11) `2fe380dbf` keys, and editors, from a controller [S25] | The specialisation hooks the Originals extension uses, and (#1) how witnesses verify a candidate entry. #11's "Editors from a Controller" is the engine's editor hook (`ControllerKeys.editors`), which the Originals profile implements with its grants (P5.15–P5.18). |
| [did:vh](https://github.com/swcurran/didvh/tree/e0b7cbad27d7b2274057251f85687e133329b5a9/spec) | `swcurran/didvh@e0b7cbad27d7b2274057251f85687e133329b5a9` | The `did:vh:<SCID>` identifier, `src`, DID URLs, resolution options and errors. |
| did:vh pull request, treated as merged | [#3](https://github.com/swcurran/didvh/pull/3) `b3e7a56d` extensions | Lets the Originals extension define its own state, parameters and `src` kinds. |
| [did:webvh on VH-Log (experimental)](https://github.com/decentralized-identity/didwebvh/tree/deef9cf12b9543475a1df70322c362876dc89a58/spec-exp) | `decentralized-identity/didwebvh@deef9cf1` (PR 302), method value `did:webvh:1.0` | Author DIDs and an Original's web alias. Logs written by `didwebvh-ts` (did:webvh 1.0) must verify under it. |
| [Data Integrity BIP340 Cryptosuite](https://dcdpr.github.io/data-integrity-schnorr-secp256k1/) | v0.1 draft | `bip340-jcs-2025`. Its draft inconsistencies are recorded as S6 in the plan. |
| [Data Integrity EdDSA Cryptosuites](https://www.w3.org/TR/vc-di-eddsa/) | W3C Recommendation | `eddsa-jcs-2022`. |

The SDK baseline cited by the Originals spec is `onionoriginals/sdk@00fc683`.

### Provisional choices

The pinned spec leaves the asset state schema, the `originals:1.0` method
values, the entry field names and digest encoding, the evidence package format
and the hosted layout open (D1, D4), and section 14 records the SDK's choices
for them as provisional wire-format values (P14.1–P14.11). Where section 14
asked the SDK to change (the `signers/` package directory, no asset witness
file, entry size in UTF-8 bytes, a 64 MiB resource fetch limit), the SDK
follows it. The Bitcoin values (P14.12) and the limits (P14.13) are decided by
the owner (#50), and so is the inscription's shape: entries in CBOR metadata,
the resource version as its body under its own media type (#53), as are the parts of P14.2, P14.3, P14.5 and P14.8 that D4
records (the line format, the 2^53 − 1 bound, `name` in UTF-16 code units, the
five proof members) and the ZIP writer binding of P14.10 (#51), and so are JCS, SHA-256 multihash digests
(P14.7), the two cryptosuites and the absence of an asset witness file (D3,
D4, as #52 states), so they carry no `PROVISIONAL` marker. The entry state
fields, the package format and its `signers/` layout, the digest encoding,
the JSON-to-CBOR mapping of inscription metadata (ord's for `--json-metadata`,
P14.12), the active-content media types the SDK warns about (P9.18) and the
did:btco regex and CBOR details stay provisional. So does everything in
section 14's carried-log and EVM subsections (P14.14–P14.22): P14.21 pins
no anchor contract, so a writer refuses an `anchor` member and a verifier
reports one as unsupported, and P14.22's chain list and trust classes are
assessments as of PR 59. Section 2 of
the plan records the provisional choices this repository makes. Code that
depends on one is marked `PROVISIONAL` and cites the decision. A provisional
choice is not a published test vector, and nothing built on one supports an
interoperability claim.

### Spec findings

Section 4 of the plan lists the places where the pinned documents are
ambiguous or conflict (S1–S8). Where a finding blocks implementation, work on
that rule stops until the spec is corrected. Code never silently diverges from
the pinned text.

The owner decisions that departed from the earlier pin are now in the pinned
stack, so none is a departure any more:
- Only an anchor settles a fork (S1, Q5): originals-spec PR #34, P6.6 and
  P9.16. Under PR 59 an EVM anchor settles one too, but only under its
  chain's finality and trust class, and on a `consortium` or `operator`
  chain the settlement is attested, never proven (P9.24, P9.27).
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
- At `master` `1039c471c` the table has 159 rows. Rows 1–153 are the same
  rows at the same positions (#47 and #48 merged; rows 146–153, C12-146 to
  C12-153, lose their `proposal`, and stay PROVISIONAL as section 14 values).
  Three are reworded: row 16 (C12-16, a resource added or removed by an author
  entry is accepted, P4.1, P4.4; #49), 43 (C12-46, an anchored entry's
  did:vh or did:webvh signer checked against the newest known version, P7.8,
  P9.15; #47) and 62 (C12-64, the newer retained author DID version is used,
  P7.8; #47). Rows 154–159 are new (#49): C12-154 to C12-159. No row was
  removed, so none is retired.
- At `master` `19d3e82a0` (#50 and #51 merged), and unchanged at `b599fd14b` (#52), the table has 189 rows. Rows
  1–159 keep their IDs; #51 inserts a row at 101 (C12-176, the P9.18 labels
  after submission), so rows after it move by one, and rewords rows 9, 60,
  100, 119 and 125 (C12-09, C12-62, C12-100, C12-118, C12-124). Row 161 is
  #50's (C12-160, 256 resources accepted, 257 rejected). Rows 162–189 are
  #51's: C12-161 to C12-189. No row was removed, so none is retired.
- At `master` `a9ecdbb` (#53 merged) the table has 190 rows. #53 rewords ten
  rows, which keep their IDs: C12-16 (an entry with no resource or more than
  one is rejected, P4.1), C12-19 (an unchanged digest leaves `transitions`
  empty), C12-37 (did:btco DID-document metadata is not an Originals
  inscription), C12-97 (uninscribed versions unavailable), C12-111 and C12-112
  (metadata and body together at 350,000 bytes), C12-114 (the resource as
  granted content), C12-142 (the grant limit only), C12-159 (the transitions
  of the genesis entry, a changing entry and any other entry) and C12-173 (the
  asset log only). It adds eight rows: C12-190 (row 98, the current version
  read from Bitcoin alone) and C12-191 to C12-197 (rows 115–121: body digest
  and size, content type and encoding, the author's notice before inscribing,
  a name-only inscription carrying the current version again, CBOR items that
  are rejected, metadata split over pushes, entries checked over their JCS
  form). Seven rows about resource sets are gone, and their IDs are retired
  under `retired` in the registry, never reused: C12-154, C12-155, C12-156,
  C12-157, C12-158, C12-160 and C12-171.
- At `master` `45ed1dc` (#54 merged) the table has 192 rows. Row 119
  (C12-195) is reworded: a float is no longer in its rejected list. Two rows
  follow it: C12-198 (row 120, a non-integer metadata number inscribed as a
  float of any width is accepted and checked over JCS) and C12-199 (row 121,
  a NaN, infinite, negative-zero or out-of-bound float is rejected). Rows
  after them move by two. No row was removed.
- At `3ed0f89`, the head of open PR 59 on `master` `915b726` (#58 merged),
  the table has 300 rows. Rows 1–192 keep their IDs and positions. PR 59
  rewords two: C12-23 (divergent branches "not settled by an anchor", not
  "on Bitcoin") and C12-188 (its result cites section 7 as well). Rows
  193–285 are #58's (carried logs, EVM anchoring, moves and did:evm) and rows
  286–300 are PR 59's; they are C12-200 to C12-307, each its position plus
  seven. No row was removed, so none is retired. Rows tested only in Solidity
  (`contracts/test`) or in the gated anvil integration test stay `todo`, with
  a note naming the test, because the registry counts only the Bun unit roots.

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
