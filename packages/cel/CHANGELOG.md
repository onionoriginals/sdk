# @originals/cel

## 0.2.0-next.1

### Minor Changes

- 5f0788f: Production providers can now verify btco-anchored did:cel assets end to end (#473).

  `getAnchoringsForDidCel` — the capability `verifyEventLog` requires for #402 first-anchor-wins uniqueness — was implemented only by the `OrdMockProvider` test double, so every btco-anchored asset failed verification (`UNIQUENESS_UNVERIFIABLE`) against `QuickNodeProvider` or `OrdHttpProvider`.

  The contract now has two documented conformance tiers, and the verifier passes the log's own anchored sat as a scope hint (`getAnchoringsForDidCel(didCel, { satoshi })`):

  - **FULL** (a global back-link index, e.g. `OrdMockProvider`): enumerates anchorings on any sat; cross-sat legitimate-duplicate detection via authenticated competitors (#402) works.
  - **SAT-SCOPED** (now implemented by `QuickNodeProvider` and `OrdHttpProvider` via a shared helper): enumerates only the log's own anchored sat, since ord exposes no did:cel back-link index. This proves the claimed anchoring EXISTS on-chain, back-linked and height-confirmed; it does NOT check cross-sat canonicality — behaviourally identical to the already-accepted `didDocument`-omitting degraded mode, so no #402 security property is weakened: uniqueness stays fail-closed and non-opt-in, and sat-scoped providers throw (`ANCHORING_ENUMERATION_UNSCOPED`) rather than fabricate an empty enumeration when called without a scope.

  Backward compatible: existing single-argument implementations of the optional method remain valid.

## 0.2.0-next.0

### Minor Changes

- 5e89cba: Extract the CEL core into `@originals/cel` (plan 044, item 6).

  `@originals/cel` is the browser-safe half of the protocol: create, append, and
  verify Cryptographic Event Logs offline. It carries only `@noble/*`,
  `@scure/base`, `cborg`, and a lazily-loaded `@aviarytech/did-peer` (legacy
  did:peer:4 read path) — no Bitcoin stack, no `jsonld`, no `didwebvh-ts`, no
  Node builtins. Subpath exports: `.` (CEL core + shared primitives: `multikey`,
  `StructuredError`, satoshi validation, DID/proof types), `./encoding`,
  `./cbor`, and `./testing` (`OrdMockProvider`).

  `@originals/sdk` now depends on `@originals/cel` and re-exports everything it
  exported before — the root entry, `@originals/sdk/cel`, and
  `@originals/sdk/testing` surfaces are unchanged, so no consumer imports break.
  The `originals-cel` CLI still ships from the SDK (it drives the full
  OriginalsSDK lifecycle and needs `fs`/`path`). Type-only couplings were cut
  structurally: `BtcoCelManager`/`BitcoinWitness`/`OriginalsCel` now accept a
  `CelBitcoinManager` structural slice (satisfied by `BitcoinManager` as-is) and
  `createDidManagerKeyResolver` a `CelDidResolver` (satisfied by `DIDManager`).
