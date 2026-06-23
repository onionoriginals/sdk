# Plan 026: Fix placeholder scriptPubKey in BitcoinManager.transferInscription fallback

## Status

- **State**: DONE (branch `correctness/round1-5`)
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Category**: correctness
- **Planned at**: atop `origin/main`@`b03e50d`, 2026-06-22

## Why this matters

`BitcoinManager.transferInscription` returns a `BitcoinTransaction`. When the
configured `OrdinalsProvider` does not return `vout` data, the method
synthesizes a single fallback output:

```ts
[{ value: DUST_LIMIT_SATS, scriptPubKey: 'script', address: toAddress }]
```

`scriptPubKey` is typed as a hex-encoded Bitcoin output script (see
`TransactionOutput`/`UTXO` in `src/types/bitcoin.ts`, and the consumers in
`bitcoin/transactions/commit.ts` which do `Buffer.from(utxo.scriptPubKey,
'hex')`). The literal string `'script'` is **not valid hex** — decoding it with
`Buffer.from('script', 'hex')` silently produces garbage/truncated bytes, so any
downstream code that references this output as an input (witness construction,
re-spending the transferred inscription) builds a corrupt transaction.

### Root cause

The fallback was a placeholder that was never replaced with a real
address-derived script. The destination address (`toAddress`) is already
validated against `this.config.network` earlier in the method, so we have
everything needed to derive a correct `scriptPubKey`.

## The fix

There is already a correct, tested helper in `src/bitcoin/transfer.ts`,
`addressToScriptPubKey(address, network)`, which decodes an address and encodes
its `OutScript` to hex via `@scure/btc-signer`. It was module-private.

1. Export `addressToScriptPubKey` from `transfer.ts` and a small
   `scriptPubKeyForAddress(address, network)` convenience that maps the SDK's
   `'mainnet' | 'regtest' | 'signet'` config network to the scure network and
   returns the hex script.
2. In `BitcoinManager.transferInscription`, replace the placeholder
   `scriptPubKey: 'script'` with `scriptPubKeyForAddress(toAddress,
   this.config.network)`, producing a valid hex script for the fallback output.

The address is already validated above, so derivation cannot fail on an invalid
address. No public API shape changes (the `BitcoinTransaction` return type is
unchanged; the output is now correct instead of a placeholder).

## Regression test

`tests/unit/bitcoin/transfer-inscription-scriptpubkey.test.ts`: configures a
mock `OrdinalsProvider` whose `transferInscription` returns a response with NO
`vout` (forcing the fallback path), then asserts the returned `vout[0]
.scriptPubKey` is valid lowercase hex and decodes to the same script as the
destination address. Fails before the fix (`'script'` is not hex), passes after.

## Out of scope

The same `scriptPubKey: 'script'` placeholder appears in the *mock* providers
(`OrdMockProvider`, `OrdHttpProvider`). Those are test/dev doubles whose `vout`
is consumed only as illustrative data; fixing the production fallback in
`BitcoinManager` is the load-bearing correctness change. Mocks left untouched to
keep the fix minimal.
