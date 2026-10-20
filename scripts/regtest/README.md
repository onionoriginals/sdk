# Regtest journeys

Run `bun run regtest` from the repository root. The runner verifies and installs
pinned Bitcoin Core 31.1 and ord 0.29.0 binaries (SHA-256 checked), builds the
workspace packages, typechecks the harness, and runs disposable chains in turn:

- `apps/landing/scripts/sat-snapshot-no-address.ts`: one SDK-built inscription,
  a sat snapshot without the address index, a real sat transfer, and chain
  validation against an independent Core node;
- `scripts/regtest/restart-check.ts`: Core and ord restarts;
- `scripts/regtest/originals-anchor.ts`: anchored Originals end to end (plan 011
  PR 10, plan 012).

The Originals journey asserts each step on real transactions:

1. A local Original is anchored to a sat the wallet holds, and the anchoring
   entry is inscribed on it. Broadcast but unmined, it does not count (P9.4);
   mined, the Original verifies as anchored and current, with provisional
   ownership of the reveal output (P9.11, P9.16).
2. An edit is reinscribed on the same sat by spending the output that holds it
   (P9.12, P9.13).
3. A pair whose first funding UTXO holds another sat is refused.
4. A reorganisation replaces the edit's block with empty blocks: the edit drops
   to the mempool and the verifier reports `authoritative-source-changed`; the
   next block includes it again (P9.5).
5. A crash after the commit broadcast leaves a durable recovery record;
   resuming rebroadcasts the same signed pair, and the published boundary
   advances only when the reveal is mined (P9.4, P9.6).
6. An entry the author signs but nobody inscribes is never current (P9.12).

`REGTEST_RECEIPT=/absolute/path/receipt.json` writes receipts (the Originals
journey writes `<receipt>-originals.json`), and `REGTEST_LOGS_DIR` keeps the Core
and ord logs. Set both `BITCOIND_BIN` and `ORD_BIN` to use installed binaries.
The runner uses no public Bitcoin network and spends nothing outside regtest.

The signer is a disposable local key. This proves the transaction path, not a
live Turnkey call, a hosted deployment or mainnet; the owner's mainnet release
proof is separate.
