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
