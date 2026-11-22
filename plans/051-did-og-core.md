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

### F5. P5.8 and T5-030: telling the DIF did:vh from the VH-Log-based pre-draft

T5-030: "did:vh signer DID whose log `method` value is not a did:vh value the
verifier implements, such as the VH-Log-based pre-draft's". [S3] gives the DIF
did:vh the method value `did:vh:1.0`. If the pre-draft (swcurran/didvh-old)
also wrote `did:vh:1.0`, the method value alone cannot tell them apart, and
P5.8's test ("a log whose `method` value is that of another did:vh") does not
work. **Proposed fix:** name the pre-draft's method value in [S3]'s note, or,
if it is the same string, give P5.8 another test (for example the did:webvh
entry format and its `created` proofs). The SDK verifies a did:vh signer's log
under did:webvh's format with `did:vh:1.0`, whole seconds and id
`did:vh:<SCID>`, and treats any other method value as no evidence.

### F6. P7.18 and P14.25: the `checkpoint` of a `conflict` report

P14.25: "`checkpoint`, the versionId of the reported checkpoint, or null when
`state` is `none`". P7.18 `conflict`: "no branch's state is reported as the
Original's". Neither says what `checkpoint` is under `conflict`.
**Proposed fix:** under `conflict`, `checkpoint` is the last entry common to
every branch (the fork point). The SDK does that, PROVISIONAL.

### F7. P7.18: `outcome` when no checkpoint can be reported

P3.2 requires exact-checkpoint resolution to "report why it cannot", and
P7.18 has `state` `none`, but its `outcome` rule makes such a report
`verified` when nothing else failed (a named checkpoint absent from the
evidence set, or an evidence set with no entry). **Proposed fix:** P7.18 adds
"`incomplete` when `state` is `none` because the evidence set lacks the
target" and P14.25 a `reason` member. The SDK reports `state` `none`, keeps the
outcome formula as written, and gives a `reason` (PROVISIONAL).

### F8. P7.18 and P14.25: reasons for missing items

P7.18: "For each missing or failed item, it gives a reason." P14.25:
"`missing`, as in the manifest (P14.10)", whose items have no reason member,
and the vectors give none. **Proposed fix:** either add an optional `reason`
to report `missing` items, or say the item kind is its reason. The SDK
follows the vectors (no reason member); a failed entry's reason is its `rule`.

### F9. P7.21: `offline` for an evidence set that is not a package

P7.21: "The `offline` axis is computed over the supplied package or carried
file". The genesis vector supplies loose files (a log, a signer history, a
resource) and expects `self-contained`. **Proposed fix:** P7.21 says the axis
is computed over the supplied local inputs (package, carried file or loose
files), excluding anything fetched from a host or index. The SDK does that,
PROVISIONAL: inputs whose source is an `http(s)` URL count as external.

### F10. P9.36, P6.6, T9-034: where a report states a change of head

P9.36: "the report MUST state the change of head"; P6.6 and T6-017 likewise
for a newly found fork, and T9-034 names a label
`authoritative-source-changed`. P14.25 lists no member for any of this, and
says a report has "exactly these members". **Proposed fix:** add
`headChange: {from, to}` (or the label T9-034 uses) to P14.25, present only
with a prior result. The SDK writes `headChange` (PROVISIONAL).

### F11. P7.21 and P14.25: the `kind` values of `dependencies`

P14.25: "`dependencies`, the external dependencies P7.21 lists, each `{kind,
did}`". The bitcoin vector uses `anchoring-sat`; P7.21's other two
dependencies (a did:btco signer's sat, a signer DID whose history the package
lacks) have no kind value. **Proposed fix:** list `anchoring-sat`,
`signer-sat` and `signer-history`. The SDK uses those (PROVISIONAL).

### F12. P6.7 and section 14 "Shared-host saves": refusing a submission that does not verify

P6.7 requires a host to accept an entry only if it "verifies under this
profile against that head", and section 14's guide gives the answers
`accepted`, `already-accepted` and `stale-parent`. Neither gives the answer
for a submission whose parent is the head but which does not verify (a bad
proof, a change outside a grant, a P7.20 refusal, bytes that do not match).
**Proposed fix:** add `rejected` with the rule the entry fails. The SDK's
host answers `{result: "rejected", rule, reason}` (PROVISIONAL), and over HTTP
uses 201, 200, 409 and 422 for the four answers.
