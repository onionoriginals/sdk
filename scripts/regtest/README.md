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
3. The head Bitcoin already shows is not inscribed again when asked for
   explicitly (`HEAD_NOT_NEXT`, P9.13).
4. A reorganisation replaces the edit's block with empty blocks: the edit drops
   to the mempool and the verifier reports `authoritative-source-changed`
   against the version Bitcoin showed before (the read retains only what
   Bitcoin accepted); the next block includes it again (P9.5). The inscription
   clock follows the reorganisation by block hash.
5. A pair whose first funding UTXO holds another sat is refused (`WRONG_SAT`).
   A crash after the commit broadcast leaves a durable recovery record; the
   reveal never reaches the node, and with the commit mined the published
   boundary does not move. Resuming rebroadcasts the same signed pair, and the
   inscription Bitcoin then shows is that pair's (P9.4, P9.6).
6. An entry the author signs but nobody inscribes is never current (P9.12),
   and an entry after it cannot be inscribed first (`HEAD_NOT_NEXT`).
7. Catching up: the two uninscribed entries are published with `catchUp`, one
   block at a time, re-reading Bitcoin's accepted head before each. The
   process dies after the first commit broadcast; the next step resumes that
   recorded pair (same reveal), and while its reveal is unmined the step waits
   rather than preparing it again. Each accepted inscription is at a strictly
   greater height, and once Bitcoin shows the committed head there is nothing
   to inscribe (`NOTHING_TO_INSCRIBE`) (P9.4, P9.6, P9.13).
8. A second Original is edited before its anchoring entry is published:
   catching up inscribes the anchoring entry first (asking for the edit first
   is `HEAD_NOT_NEXT`), then the edit in a later block.

The recovery store in this journey is in memory: step 7 shows resuming within
one process, not after a process restart.

`REGTEST_RECEIPT=/absolute/path/receipt.json` writes receipts (the Originals
journey writes `<receipt>-originals.json`), and `REGTEST_LOGS_DIR` keeps the Core
and ord logs. Set both `BITCOIND_BIN` and `ORD_BIN` to use installed binaries.
The runner uses no public Bitcoin network and spends nothing outside regtest.

The signer is a disposable local key. This proves the transaction path, not a
live Turnkey call, a hosted deployment or mainnet; the owner's mainnet release
proof is separate.
