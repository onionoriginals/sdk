# Plan 051: the did:og 1.0 core

Owner approval (21 November 2026): implement the full did:og 1.0 core and a
mainnet anchoring command.

## Source of truth

The spec is `aviarytech/originals-spec` pull request 69, branch
`design-review-did-og-core`, head `6e0e3f9`: `spec/*.md` is the core and
`spec/additions/` is out of scope. Method value `og:1.0-draft.1`. Its
vectors are copied into `packages/vh/tests/fixtures/og-vectors/` (see `PIN.md`
there); the spec repository's `vectors/tools/check.mjs` is the independent
second implementation, so no code from the spec's generator is used here.

The prior format (`originals:1.0`, `did:vh` identifiers) gets outcome
`unsupported` from the did:og verifier (P14.1, T14-085). No migration (D7).

## Stack

| PR | Branch | Scope |
|---|---|---|
| 1 | `og/1-log-format` | `@originals/vh/og`: the log format (P14.1–P14.3, P14.8, P14.27–P14.29) and the genesis vector's bytes |
| 2 | `og/2-entries-package` | Entry state and transitions (P14.4–P14.7, P4, P5.15–P5.16, P6.5, P9.30 shape rules), the evidence package (P14.10) and the local vector's bytes |
| 3 | `og/3-verifier-report` | The verification report as a pure function of an evidence set (P7.17–P7.23, P14.25), signer binding for did:webvh, the DIF did:vh and did:btco (P5.3, P5.8, P5.13, P5.14), authority labels, endorsement, forks and `supersedes` (P6.6, P6.9); the genesis and local reports |
| 4 | `og/4-hosted` | Shared-host saves (P6.7), the hosted layout (P14.11, P9.7), the did:webvh alias (P3.6) and the hosted vector |
| 5 | `og/5-bitcoin` | Inscription metadata and envelopes (P14.12), publications in parts (P9.32), the P9.15 table, anchors (P9.16), inscribed signer histories (P9.33), one SCID per sat (P9.34), the bitcoin and prior-format vectors |
| 6 | `og/6-anchor-cli` | The SDK's did:og workflow and the mainnet anchoring command, with an end-to-end regtest run |

## Spec findings

Recorded for the spec thread on PR 69, with the rule ID, the quoted text and
a proposed fix. Nothing here is guessed silently: where the SDK has to pick,
the code is marked `PROVISIONAL` and cites the finding.

(The list is kept current in each PR of the stack.)

### F1. P14.12: the bitcoin vector's CBOR member order is not JCS order

P14.12: "a writer MUST write the metadata's members in the order `entries`,
`signers`, `part`, each `signers` item's in the order `did`, `log`, `witness`,
and each entry and signer log entry with its members in the order of its JCS
form". `bitcoin/inscriptions/part-1.metadata.cbor` writes each entry as
`versionId, versionTime, parameters, state, proof`, its state as `id,
operation, author, asset, transitions` and its asset as `name, status,
network, resource, aliases`, and the signer log entry the same way: the
generator's in-memory order, which is neither JCS order nor the order of the
`did.jsonl` lines (which are JCS). A writer that follows P14.12 cannot
reproduce `part-{1,2}.metadata.cbor` or `part-{1,2}.envelope.bin`.
**Proposed fix:** regenerate the bitcoin vector with JCS-ordered maps (a new
draft number under P14.1, since the envelope bytes change), or, if the
vector's order is intended, replace "in the order of its JCS form" by an order
P14.12 spells out. The SDK writes JCS order, as P14.12 says; its tests show
that its CBOR encoder reproduces the vector's bytes from the vector's own key
order, and that its reader decodes both orders to the same entries.

### F2. P14.25 and P7.18: the shape of an `unsupported` report

`prior-format/expected-report.json` has `original: null`, `axes` holding only
`outcome`, evidence inputs `{kind, source, txid}` with no `digest`, and the
extra members `reason` and `note`. P14.25 says a report "is an object with
exactly these members", `axes` has "one member per axis", each input is
`{kind, source, digest}`, and P7.18 says a verifier "MUST NOT ... leave an
applicable axis out". **Proposed fix:** P14.25 says that under `outcome`
`unsupported` the other axes are not applicable and `axes` holds `outcome`
only, that `original` and `checkpoint` are then null, defines `reason` as an
optional member (or drops it), and either gives prior-format inputs a `digest`
(of the transaction bytes) or lists `txid` as an input member. The SDK
reproduces the vector as written and marks the shape PROVISIONAL.

### F3. P6.5 and P14.4: which `operation` a deactivation carries

P14.4: "`operation` is `create` in the genesis entry and `update` or
`deactivate` in every other entry"; P6.5 ties the `deactivated` parameter to
`status` only. Nothing says a deactivation's `operation` must be
`deactivate`, or that `deactivate` may appear only there. **Proposed fix:**
P6.5 adds "and its `operation` is `deactivate`; `deactivate` appears in no
other entry". The SDK requires all three to agree.

### F4. P9.30 and P4.4: previews key on the digest, versions on digest or media type

P9.30: "Every later entry that changes the resource's digest names a preview
made for the new version, or none" and "Every later entry that does not
change the digest ... MUST carry its parent's `preview` unchanged or carry
none". Since 21 November a `mediaType`-only change is a new version (P4.4,
P14.6), so an entry that retypes an image keeps its parent's preview rather
than one made for the new version. **Proposed fix:** confirm that "digest" is
intended, or say "changes the resource's version (its digest or
`mediaType`)". The SDK follows the text (digest).
