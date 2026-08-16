# @originals/cel

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
