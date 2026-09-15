---
"@originals/sdk": patch
---

**`validateBitcoinAddress` now accepts Taproot (P2TR/bech32m) addresses again** (#713).

The `bitcoinjs-lib` `^6.1.0` → `^7.0.2` dependency bump in #682 removed bitcoinjs-lib's bundled secp256k1 support; v7 requires callers to explicitly call `initEccLib(ecc)` before it will validate any Taproot output or address, which this package never did. Every P2TR address — the conventional choice for an inscription-holding wallet — was rejected by `validateBitcoinAddress`/`isValidBitcoinAddress`, and transitively by `lifecycle.prepareBitcoinPublication`'s `changeAddress`/reveal-destination handling, with an `ECC library` error rather than an address-validity result.

`packages/sdk/src/utils/bitcoin-address.ts` now validates addresses via `@scure/btc-signer`'s `Address().decode()` — the same address/network decoding already used elsewhere in the SDK's real Bitcoin transaction path (`bitcoin/transfer.ts`, `bitcoin/transactions/commit.ts`) — instead of `bitcoinjs-lib`'s `address.toOutputScript()`. This covers P2WPKH, P2WSH, P2TR, P2PKH and P2SH without a separately initialized ECC backend, and preserves the existing checksum/prefix/length error messages and the regtest→testnet address fallback.
