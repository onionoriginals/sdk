# Plan 027: BtcoDidResolver must recognize the `did:btco:test:` (testnet) prefix

## Status

- **State**: DONE (branch `correctness/round1-1-btco`)
- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Category**: correctness
- **Planned at**: atop `origin/main`@`334d0ec`, 2026-06-22

## Why this matters

`BtcoDidResolver.parseBtcoDid` (src/did/BtcoDidResolver.ts) parses incoming
DIDs with:

```ts
const regex = /^did:btco(?::(reg|sig))?:([0-9]+)(?:\/(.+))?$/;
```

Only the network suffixes `reg` (regtest) and `sig` (signet) are accepted, plus
the bare mainnet form. Any `did:btco:test:<SATOSHI>` DID fails the match and the
resolver returns an `invalidDid` error.

This is inconsistent with the rest of the SDK, which explicitly documents and
accepts the `test` (testnet) prefix:

- `src/utils/satoshi-validation.ts` (lines 134-160) parses
  `did:btco:test:123456` as a valid testnet identifier; only `test` and `sig`
  are accepted as 4-part network prefixes.
- `src/bitcoin/BitcoinManager.ts` `extractSatoshiFromBTCODID` (lines 304-334)
  accepts only `test` and `sig`.
- `src/did/DIDManager.ts` `resolveDID` (line 245) explicitly routes
  `did.startsWith('did:btco:test:')` DIDs into `BtcoDidResolver.resolve()`.

So `DIDManager.resolveDID('did:btco:test:123')` dispatches the DID to the
resolver, which then rejects it as `invalidDid`. Any asset/credential created or
identified on testnet via the satoshi-validation utilities produces a DID that
cannot be resolved — breaking transfer and verification workflows. This is a
provenance/correctness bug.

### Root cause

The resolver's `parseBtcoDid` regex and its `getDidPrefix` switch predate the
testnet support added to `satoshi-validation` / `BitcoinManager` and were never
updated. The two halves of the codebase disagree on the testnet prefix.

## The fix

Make the resolver accept `test` as a recognized network prefix, alongside the
existing `reg` and `sig`, with a correct round-trip:

1. `parseBtcoDid`: extend the alternation to
   `/^did:btco(?::(reg|sig|test))?:([0-9]+)(?:\/(.+))?$/`.
2. `getDidPrefix`: add a `case 'test'` (and `'testnet'`) returning
   `did:btco:test`, so the `expectedDid` used to match the inscription content
   and the DID document `id` round-trips correctly for testnet DIDs
   (`did:btco:test:123` ⇒ expected document id `did:btco:test:123`).

Existing `reg`/`sig`/mainnet behavior is unchanged; this is purely additive.
No public API shape changes.

## Regression test

`tests/unit/did/BtcoDidResolver.test.ts` gains:

- A test that `resolve('did:btco:test:3')` does NOT return `invalidDid` and that
  a matching testnet DID document is selected as the resolved document with
  `resolutionMetadata.network === 'test'`. This fails before the fix (regex
  rejects `test`, yielding `invalidDid`) and passes after.
- A unit assertion that the private `getDidPrefix('test')` maps to
  `did:btco:test` (mirrors the existing `reg`/`sig` prefix-mapping test).

## Out of scope

The naming asymmetry between `did:btco:reg` (used by `createBtcoDidDocument` /
`DIDManager` migration for regtest) and `did:btco:test` (used by
`satoshi-validation` / `BitcoinManager` for testnet) reflects two distinct
Bitcoin networks (regtest vs testnet) and is a broader design question. This fix
only ensures the resolver recognizes every prefix the rest of the SDK already
emits and routes, closing the resolution gap for `test`. Reconciling the network
taxonomy is left to a separate change.
