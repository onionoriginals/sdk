# Production-core authority fixture companion

The original [authority fixtures](../cel-authority-vectors/README.md) and their
manifest remain unchanged. Their symbolic WebVH identifiers are intentionally
not valid SCID encodings; a production DID parser must not accept them to make
tests pass.

This companion changes those two alias inputs to syntactically valid SHA-256
multihashes, recomputes the dependent links/signatures using the independent
reference tooling, and preserves all 42 hand-worked outcomes. It does not claim
that a WebVH DID-method log binds these aliases. Positions, ownership and chain
tips remain declared scenarios, not actual Bitcoin observations.

`generate-histories.mjs` is the original decision generator with only the two
alias inputs and explanatory scope text changed. `check-histories.mjs` is the
same independent reference state walk. Neither imports production CEL code.
Production tests read the saved `histories.json`; they do not regenerate their
expected results.

Verification: `node docs/research/cel-core-vectors/check-histories.mjs`.
Regeneration is explicit and requires review of resulting signed bytes and
expected outcomes. The production core also separately rejects the original
symbolic-alias migration, rather than weakening its parser.
