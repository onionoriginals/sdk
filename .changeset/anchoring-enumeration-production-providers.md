---
"@originals/sdk": minor
"@originals/cel": minor
---

Production providers can now verify btco-anchored did:cel assets end to end (#473).

`getAnchoringsForDidCel` — the capability `verifyEventLog` requires for #402 first-anchor-wins uniqueness — was implemented only by the `OrdMockProvider` test double, so every btco-anchored asset failed verification (`UNIQUENESS_UNVERIFIABLE`) against `QuickNodeProvider` or `OrdHttpProvider`.

The contract now has two documented conformance tiers, and the verifier passes the log's own anchored sat as a scope hint (`getAnchoringsForDidCel(didCel, { satoshi })`):

- **FULL** (a global back-link index, e.g. `OrdMockProvider`): enumerates anchorings on any sat; cross-sat legitimate-duplicate detection via authenticated competitors (#402) works.
- **SAT-SCOPED** (now implemented by `QuickNodeProvider` and `OrdHttpProvider` via a shared helper): enumerates only the log's own anchored sat, since ord exposes no did:cel back-link index. This proves the claimed anchoring EXISTS on-chain, back-linked and height-confirmed; it does NOT check cross-sat canonicality — behaviourally identical to the already-accepted `didDocument`-omitting degraded mode, so no #402 security property is weakened: uniqueness stays fail-closed and non-opt-in, and sat-scoped providers throw (`ANCHORING_ENUMERATION_UNSCOPED`) rather than fabricate an empty enumeration when called without a scope.

Backward compatible: existing single-argument implementations of the optional method remain valid.
