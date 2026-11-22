# did:og test vectors (copied fixtures)

Copied verbatim from `aviarytech/originals-spec`, pull request 69 (branch
`design-review-did-og-core`), head `ccf4a69`, directories `vectors/og-1.0-draft.1/`,
`vectors/prior-format/` and `vectors/regtest/last-run.json`. Provisional, like
the parts of section 14 they exercise (P14.26). No code from the spec
repository's generator is used: the SDK reproduces these files from its own
implementation, so that it and `vectors/tools/check.mjs` are two independent
implementations (T14-091, D21).

The keys are test keys: each secret is
`SHA-256("originals-spec test vector seed: <label>")`. Never use them for anything else.
