# Plan 051: the did:og 1.0 core

Owner approval (21 November 2026): implement the full did:og 1.0 core and a
mainnet anchoring command.

## Source of truth

The spec is `aviarytech/originals-spec` master `3c7b6db`, where pull
request 69 merged, with pull request 84 (branch `sdk-findings`, head
`5281746`, not yet merged), which resolves every finding of this plan. Its
vectors are unchanged since `45dc624`.
`spec/*.md` is the core and `spec/additions/` is out of scope. Method value `og:1.0-draft.1`. Its
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
| 7 | `og/7-no-inscribed-signers` | D22: inscriptions carry no signer histories; did:vh / did:webvh signers of inscribed entries come from resolution, checked at the version they name |

## D22: no inscribed signer histories (owner decision, 22 November 2026)

The spec text is being rewritten for D22 on the spec branch
`no-inscribed-signers`; `og/7-no-inscribed-signers` implements it ahead of
that text:

- Inscription metadata is `{entries, part?}` (P14.12). The writer never
  writes `signers`; the reader ignores a `signers` member whatever it holds
  (older inscriptions, including the mainnet one, carry it) and never uses it
  as evidence; any other unknown member still invalidates the metadata.
  Multi-part sizing (P9.32) and the limits (P14.13) count entries and the body
  only.
- A did:vh or did:webvh signer of an inscribed entry is checked against a
  supplied signer history in the evidence set, with its source and obtained
  time (P7.8, P7.17), at the version the entry names (P5.3), before or after
  the anchor. A later removal or deactivation never invalidates an inscribed
  entry: P9.15 row 8 and the P5.18 author-deactivation check apply to did:btco
  signers and authors only. did:btco signers are unchanged (P5.13).
- No supplied log gives `signer-history-missing`; a log that ends before the
  named version gives `signer-version-missing`. Both are handled like an
  unread did:btco sat: in the anchoring publication, identity `incomplete` and
  `bitcoin` `undetermined`; after it, the inscription is `unverifiable` and
  later publications `waiting`. Another versionId at the named number, or a
  failing proof, is `rejected`. Missing evidence never accepts. An undetermined
  anchoring publication of another did:og leaves ours undetermined too.
- The anchor CLI's `verify` fetches the author's `did.jsonl` from its URL (no
  redirects) and supplies it as a signer history whose source is that URL; `last-run.json` records
  whether it was served, verifies and reaches the named versions, and prints
  a warning beside the report (not in it) when the newest version removes the
  key or deactivates the DID.
- The vectors are recopied from the spec branch `no-inscribed-signers` at
  `d74f0a9` (see `PIN.md`): the bitcoin vector's part 1 has no `signers`, and
  its author log is a resolved `signer-history` input
  (`bitcoin/author/did.jsonl`, located through `bitcoin/resolved.json`). The SDK
  reproduces its expected report from that evidence set unchanged. A version
  number held under another versionId, or a failing proof, on an inscribed
  entry is rejected under P5.3.
- Also fixed on the way: the Bitcoin path recomputed `outcome` after the
  off-chain report and lost `target-missing`'s `incomplete` (P7.18, T7-076).
- `bun run regtest:og` passed all four runs on 22 November 2026 with this
  branch (Bitcoin Core 32.1, ord 0.29.1): no inscription carries `signers`,
  `verify` supplies the resolved author log, and the vector run (T14-093)
  matches the regenerated expected report with only chain-dependent values
  substituted.

## Spec findings

Status at `5281746` (spec pull request 84): every finding below is resolved.
F3, F5, F6, F7, F12, F13, F14 and F15 are resolved by adopting the SDK's
provisional choices (P6.5, P5.8 and [S3], P7.18, P3.2 with `target-missing`,
P6.7, the `sat-read` input in P14.25, and a fixed rule per diagnostic code);
F1, F2, F4, F8–F11 were resolved earlier. The SDK now follows the spec text
for each, and the code cites the rules instead of these findings. F16 is
resolved at `5281746` as proposed (P7.18, T7-076, and the section 13 ruling of
22 November 2026).

### F16. P7.18: the `binding` axis when the evidence set holds no entry

T7-076 expects `state` `none` and `outcome` `incomplete` for an evidence set
with the `did:og` and no log entry. P7.18 makes `outcome` `invalid` whenever
`binding` is `unbound`, and defines `binding` as "whether the genesis entry and
SCID bind the `did:og`", which says nothing when there is no genesis entry.
**Proposed fix:** P7.18 says that with no entry, `binding` is `bound` (nothing
contradicts it) and the `target-missing` diagnostic carries the gap. The SDK
reports `bound` in that case, so the T7-076 outcome holds.
**Resolved at `5281746`:** P7.18 now says that with no log entry `binding` is
`bound` and the `target-missing` diagnostic carries the gap, and T7-076
expects `binding` `bound`. Section 13 records the ruling. The SDK already
behaves this way.

Status at `227bd2c`: the transfer depth covers the Original's publication
history only, never the transaction that last moved the sat, whose holder
follows the adapter's confirmation policy (P7.22, P9.5, P9.11). The SDK and
the anchoring command describe the transfer check that way
(`describeTransferCheck`), and T7-074 pins it. Status at `b4f3604`: F1 is resolved (CBOR map members may be in any order;
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

## Matrix coverage (section 12 at 5281746)

A row counts as covered when a test cites its ID: the vh, host and SDK test
suites, plus `packages/sdk/scripts/og-vector-regtest.ts` and
`og-anchor-regtest.ts`, which run on a real regtest chain (T14-093 among
them). Retired IDs (T9-110, T9-137, T9-138, T9-139) are not counted.

| Section | Covered |
|---|---|
| §3 | 11/13 |
| §4 | 7/10 |
| §5 | 50/62 |
| §6 | 23/30 |
| §7 | 69/76 |
| §8 | 8/12 |
| §9 | 127/135 |
| §14 | 102/102 |
| **All** | **397/440** (307/440 before the 22 November pass) |

Not covered yet: T3-005 T3-012 T4-002 T4-003 T4-005 T5-004 T5-015 T5-040 T5-041 T5-044 T5-050 T5-051 T5-052 T5-053 T5-055 T5-057 T5-058 T6-001 T6-002 T6-003 T6-007 T6-009 T6-014 T6-026 T7-003 T7-009 T7-019 T7-033 T7-034 T7-038 T7-057 T8-003 T8-004 T8-005 T8-006 T9-016 T9-020 T9-027 T9-092 T9-125 T9-126 T9-128 T9-129

What the gaps are:

- **SDK-actor rows for a durable local store, editing and import** (T4-002,
  T4-003, T4-005, T5-055, T5-057, T5-058, T6-001–T6-003, T6-026, T7-003,
  T7-009, T8-003–T8-006, T9-016, T9-125, T9-126, T9-128): the did:og SDK in
  this stack is the anchoring writer only. These belong with the did:og
  create/edit/load workflow that replaces `originals:1.0` in the SDK.
- **Verifier rows not yet written as tests**: T3-005, T3-012, T5-004,
  T5-015, T5-040, T5-041, T5-044, T5-050–T5-053, T6-007, T6-009, T6-014,
  T7-019, T7-033, T7-034, T7-038, T7-057, T9-020, T9-027, T9-092, T9-129.
- **Fetching** (§8): `fetchEvidence` (`@originals/vh/og`) is how a caller adds
  fetched inputs to an evidence set; the verifier itself still never fetches
  (P7.17). T8-001, T8-002 and T8-007–T8-012 are tested with an injected
  resolver and transport.

## Regtest and signet

`bun run --cwd packages/sdk regtest:og` (Bitcoin Core 32.1, ord 0.29.1) runs the
anchoring command end to end four times on a disposable regtest chain and
writes `packages/sdk/scripts/og-*.last-run*.json`. All four passed again at
45dc624 on 22 November 2026, as did the vector run (T14-093).

**CLI rehearsal (22 November 2026).** The owner's commands from `OG-ANCHOR.md`
were run as written with `node dist/og/cli.js` (keygen, then `anchor author`,
`prepare`, `fund`, `broadcast`, `verify`), on regtest with `--rpc-url`,
`--rpc-auth` and `--ord`, the author's `did.jsonl` served over HTTPS from a
local host (`--domain og-rehearsal.localhost:8444`, a self-signed certificate
trusted through `NODE_EXTRA_CA_CERTS`), and a PNG with its generated WebP
preview. Every step passed: `verify` exited 0 with `verified`, `current`,
`anchored`, the transfer check passing and the host copy matching. It found
one bug, fixed with tests (`og-cli-confirm.test.ts`): an answer piped on
standard input was lost when input ended during `fund`'s wait for the funding
output ("readline was closed"). On mainnet, confirmations now have to be
typed at a terminal after the question.

Signet was not run: every signet faucet found needs a captcha or an account
login, which an unattended run cannot complete. The commands are the same
with `--network signet` (default backends mempool.space/signet and
signet.ordinals.com).

**Mainnet dry run.** `anchor author` and `anchor prepare --network mainnet`
were run with no funding, under a logger of every HTTP request. `prepare`
printed 1 inscription, about 1,645 sats in fees at mempool.space's 1 sat/vB,
and EXACTLY 2,645 sats to fund (fees plus 1,000 sats postage). The only
requests were two GETs (the author's `did.jsonl` and
`mempool.space/api/v1/fees/recommended`). Nothing is signed for the chain or
broadcast before `fund` and `broadcast`.
