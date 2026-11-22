# Plan 051: the did:og 1.0 core

Owner approval (21 November 2026): implement the full did:og 1.0 core and a
mainnet anchoring command.

## Source of truth

The spec is `aviarytech/originals-spec` pull request 69, branch
`design-review-did-og-core`, head `b4f3604` (retargeted from `6e0e3f9`, then `ccf4a69` and `0c859c0`, on 22 November 2026): `spec/*.md` is the core and
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

Status at `b4f3604`: F1 is resolved (CBOR map members may be in any order;
the vector envelopes are a read fixture, and metadata must decode to the
same JSON values, T14-097, T14-098). F10 is moot: comparison against a prior
result was removed (owner decision, 22 November 2026), so an evidence set has
no prior result and a report has no `changes`; reorganizations are met by the
transfer check's depth of 6 confirmations instead (P7.22, P14.13), with an
`insufficient-depth` diagnostic for a shallower publication. F15's
`prior-result` half is moot; its `sat-read` half is still open. Status at `0c859c0`: F8, F9, F10 and F11 are resolved too: reports now give typed `diagnostics` (each with a reason), `offline` is derived from the evidence set including loose inputs (P7.21), `changes` records head and holder changes with a cause, and `dependencies` is gone. F13 is half resolved: the new `reorg/` vector supplies its index read as a `sat-read` input, but `bitcoin/` still keeps its reads in `chain.json`. F14 and F15 are new. Status at `ccf4a69`: F2 is resolved (P14.25 now defines an `unsupported`
report, and the prior-format vector matches it); F4 is resolved (P9.30 uses
P4.4's new-version predicate, T9-134). The others are still open. `ccf4a69`
also made did:og's own rules authoritative for the asset log (P5.5–P5.7,
T5-060), added P9.15 row 6 (missing author evidence for a post-anchor editor
entry is `unverifiable`, T9-130–T9-133) and endorsement of an editor entry
after the editor DID's deactivation (P7.20, T7-065, T7-066); the SDK follows
all three. Vector comparisons are whole reports and canonical entry bytes
(P14.26), as the SDK's tests already did.

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

### F13. P7.17, P9.18 and the bitcoin vector: the index reads are not in the evidence set

P7.17 puts in the evidence set "what the index read at that tip: the
complete list of inscriptions on the anchoring sat ..., with their holders",
and P9.18 calls the bitcoin vector's evidence set exactly that. But
`bitcoin/evidence-set.json` lists only the two inscriptions (`kind`,
`source`, `digest`); the sat each is on, its block, transaction and
inscription index, its confirmations and the holder, which the expected
report depends on (`block`, `bitcoin.sat`, `bitcoin.holder`), are only in
`chain.json`. **Proposed fix:** add the index reads to the evidence set (a
`sats` member: per sat, the index, whether the list is complete, each
inscription's id, position and confirmations, and the holder), or say in
P14.26 that `chain.json` is part of the evidence set. The SDK's evidence set
has a `sats` member, and its tests build it from `chain.json`.

### F14. P14.25: the `rule` of each diagnostic code is not fixed

P14.25 compares reports as JSON values ignoring only `reason`, so a
diagnostic's `rule` must agree between implementations, but P14.25 gives it
only as "the rule number under which the item is missing or failed, such as
`P7.4`". The vectors fix `resource-missing` as `P7.4`, and the checker uses
`P5.6` for `signer-history-missing`. **Proposed fix:** one rule per code. The
SDK uses `P7.4` for both resource codes, `P5.6` for `signer-history-missing`,
`P7.8` for `signer-version-missing`, `P7.19` for `proof-unchecked`, the failed
rule for `entry-rejected`, `P7.14` for an anchor named by a copy and not read,
`P9.17` for an anchoring sat read but not in full (`P9.10` when the indexes
disagree), `P9.35` for `signer-sat-not-read`, `P9.15` for
`inscription-unverifiable`, `P9.36` for `publication-waiting` and `P7.17` for
`input-unusable`, all PROVISIONAL.

### F15. P7.17: the `sat-read` and `prior-result` inputs have no defined form

The `reorg/` vector adds evidence inputs of kinds `sat-read` (JSON with
`network`, `sat`, `tip` and `inscriptions`) and `prior-result` (a report).
No rule defines their members: what an inscription item in `inscriptions`
holds (id, position, confirmations), how the holder and the completeness of
the read are given, or how the read relates to the `inscription` inputs.
**Proposed fix:** define `sat-read` in P14.25 or P14.26 (per inscription
`{id, sat, height, txIndex, inscriptionIndex, confirmations}`, plus `holder`
and `complete`), with envelopes as `inscription` inputs. The SDK reads that
form, with `complete` true by default and an inscription with no envelope
input counted as unread (P5.13).

## Matrix coverage (section 12 at b4f3604)

Rows cited by a test, by section: §3 8/12, §4 7/10, §5 48/60, §6 19/26, §7 43/73, §8 0/12, §9 101/135, §14 67/98 (T14-093 by
`packages/sdk/scripts/og-vector-regtest.ts` on a real regtest chain). Retired
IDs (T9-110, T9-137, T9-138, T9-139) are not counted. 293 of the
426 rows in all.

Covered: T14-001 T14-002 T14-003 T14-004 T14-005 T14-006 T14-007 T14-008 T14-009 T14-010 T14-011 T14-012 T14-013 T14-014 T14-015 T14-016 T14-017 T14-018 T14-019 T14-020 T14-021 T14-022 T14-023 T14-024 T14-025 T14-026 T14-028 T14-051 T14-052 T14-054 T14-061 T14-062 T14-063 T14-064 T14-065 T14-066 T14-067 T14-068 T14-069 T14-070 T14-071 T14-072 T14-073 T14-075 T14-076 T14-077 T14-078 T14-079 T14-080 T14-081 T14-082 T14-083 T14-084 T14-085 T14-086 T14-087 T14-088 T14-089 T14-090 T14-091 T14-092 T14-093 T14-094 T14-095 T14-096 T14-097 T14-098 T3-001 T3-003 T3-004 T3-006 T3-008 T3-009 T3-010 T3-011 T4-001 T4-004 T4-006 T4-007 T4-008 T4-009 T4-010 T5-001 T5-002 T5-003 T5-005 T5-006 T5-007 T5-008 T5-009 T5-010 T5-011 T5-012 T5-013 T5-014 T5-016 T5-017 T5-018 T5-019 T5-020 T5-021 T5-022 T5-023 T5-024 T5-025 T5-026 T5-027 T5-028 T5-029 T5-030 T5-031 T5-032 T5-033 T5-034 T5-035 T5-036 T5-037 T5-038 T5-039 T5-042 T5-043 T5-045 T5-046 T5-047 T5-048 T5-049 T5-054 T5-056 T5-059 T5-060 T6-004 T6-005 T6-006 T6-008 T6-010 T6-011 T6-012 T6-013 T6-015 T6-016 T6-017 T6-018 T6-019 T6-020 T6-021 T6-022 T6-023 T6-024 T6-025 T7-001 T7-002 T7-004 T7-005 T7-006 T7-007 T7-008 T7-010 T7-011 T7-012 T7-014 T7-015 T7-016 T7-017 T7-018 T7-020 T7-039 T7-040 T7-045 T7-046 T7-047 T7-048 T7-049 T7-050 T7-051 T7-052 T7-053 T7-054 T7-055 T7-058 T7-059 T7-062 T7-063 T7-064 T7-065 T7-066 T7-067 T7-068 T7-069 T7-070 T7-071 T7-072 T7-073 T9-003 T9-004 T9-005 T9-006 T9-007 T9-008 T9-009 T9-010 T9-011 T9-012 T9-013 T9-014 T9-017 T9-018 T9-019 T9-022 T9-023 T9-024 T9-026 T9-028 T9-029 T9-030 T9-031 T9-032 T9-033 T9-034 T9-035 T9-036 T9-037 T9-038 T9-039 T9-040 T9-042 T9-043 T9-044 T9-045 T9-046 T9-048 T9-049 T9-050 T9-051 T9-052 T9-053 T9-054 T9-055 T9-056 T9-057 T9-058 T9-059 T9-060 T9-061 T9-062 T9-063 T9-064 T9-066 T9-067 T9-068 T9-069 T9-070 T9-071 T9-072 T9-074 T9-075 T9-078 T9-079 T9-080 T9-081 T9-082 T9-083 T9-086 T9-087 T9-088 T9-089 T9-091 T9-093 T9-094 T9-095 T9-096 T9-097 T9-098 T9-100 T9-102 T9-103 T9-104 T9-105 T9-107 T9-108 T9-112 T9-117 T9-118 T9-120 T9-121 T9-122 T9-123 T9-130 T9-131 T9-132 T9-133 T9-134 T9-135 T9-136

Not covered yet: T14-027 T14-029 T14-030 T14-031 T14-032 T14-033 T14-034 T14-035 T14-036 T14-037 T14-038 T14-039 T14-040 T14-041 T14-042 T14-043 T14-044 T14-045 T14-046 T14-047 T14-048 T14-049 T14-050 T14-053 T14-055 T14-056 T14-057 T14-058 T14-059 T14-060 T14-074 T3-002 T3-005 T3-007 T3-012 T4-002 T4-003 T4-005 T5-004 T5-015 T5-040 T5-041 T5-044 T5-050 T5-051 T5-052 T5-053 T5-055 T5-057 T5-058 T6-001 T6-002 T6-003 T6-007 T6-009 T6-014 T6-026 T7-003 T7-009 T7-013 T7-019 T7-021 T7-022 T7-023 T7-024 T7-025 T7-026 T7-027 T7-028 T7-029 T7-030 T7-031 T7-032 T7-033 T7-034 T7-035 T7-036 T7-037 T7-038 T7-041 T7-042 T7-043 T7-044 T7-056 T7-057 T7-060 T7-061 T8-001 T8-002 T8-003 T8-004 T8-005 T8-006 T8-007 T8-008 T8-009 T8-010 T8-011 T8-012 T9-001 T9-002 T9-015 T9-016 T9-020 T9-021 T9-025 T9-027 T9-041 T9-047 T9-065 T9-073 T9-076 T9-077 T9-084 T9-085 T9-090 T9-092 T9-099 T9-101 T9-106 T9-109 T9-111 T9-113 T9-114 T9-115 T9-116 T9-119 T9-124 T9-125 T9-126 T9-127 T9-128 T9-129

What the gaps are:

- **Carried logs** (P7.11–P7.16, P14.14–P14.17: T7-021–T7-038, T7-041–T7-044,
  T14-029–T14-050, T14-053, T14-055–T14-060) are not implemented for did:og.
  The `originals:1.0` implementation (`packages/vh/src/originals/carried*.ts`)
  is the place to port them from.
- **Fetching** (§8, T8-001–T8-012): `@originals/vh/fetch`'s `safeFetch` has
  the P14.13 limits and the SSRF rules, but the did:og verifier never fetches
  (P7.17: it is given an evidence set), and no did:og resolver that fetches
  exists yet.
- **SDK-actor rows** for a durable local store (T4-002, T4-003, T4-005,
  T6-001–T6-003, T6-026, T7-003, T7-009, T8-003–T8-006, T9-016, T9-125–T9-128,
  T5-055, T5-057, T5-058): the did:og SDK in this stack is the anchoring
  writer only, with no durable store, edit or import workflow yet. T9-127
  (rebroadcast without re-signing) holds by construction in `stepBroadcast`
  but has no test.
- **Verifier rows** not yet written as tests: T3-002, T3-005, T3-007, T3-012,
  T5-015, T5-040, T5-041, T5-044, T5-050–T5-053, T6-007, T6-009, T6-014,
  T7-013, T7-019, T7-056, T7-057, T7-060, T7-061, T9-001, T9-002, T9-015,
  T9-020, T9-021, T9-025, T9-027, T9-034, T9-047, T9-065, T9-073, T9-076,
  T9-077, T9-084, T9-085, T9-090, T9-092, T9-099, T9-101, T9-106, T9-109,
  T9-111, T9-113–T9-116, T9-119, T9-124, T9-129, T14-027, T14-074.

## Regtest and signet

`bun run --cwd packages/sdk regtest:og` (Bitcoin Core 32.1, ord 0.29.1) runs the
anchoring command end to end four times on a disposable regtest chain and
writes `packages/sdk/scripts/og-*.last-run*.json`. All four passed on
21 November 2026. Signet was not run: getting signet coins needs a faucet
behind a captcha, and the run needs no other change (`--network signet`, the
default mempool.space and signet.ordinals.com backends).
