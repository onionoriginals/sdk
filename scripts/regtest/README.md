# Regtest journeys

Run `bun run regtest` from the repository root. The runner verifies and installs
pinned Bitcoin Core 31.1 and ord 0.29.0 binaries (SHA-256 checked), builds the
workspace packages, typechecks the harness, and runs disposable chains in turn:

- `apps/landing/scripts/sat-snapshot-no-address.ts`: one SDK-built inscription,
  a sat snapshot without the address index, a real sat transfer, and chain
  validation against an independent Core node;
- `scripts/regtest/restart-check.ts`: Core and ord restarts;
- `scripts/regtest/originals-anchor.ts`: anchored Originals end to end (plan 011
  PR 10, plan 012);
- `scripts/regtest/originals-restart.ts`: the Bitcoin writer across a real
  process kill, with durable stores and a fresh reader (#975).
- `scripts/regtest/originals-evm-move.ts`: EXPERIMENTAL (originals-spec PR 59,
  plan 011 phase 12), an Original anchored on a local anvil devnet moves up to
  Bitcoin. Skipped, with a message, when Foundry's `anvil` is not installed.

The Originals journey asserts each step on real transactions:

1. A local Original is anchored to a sat the wallet holds. The SDK verifies
   the log and the author's identity evidence through the anchoring entry,
   reports what Bitcoin will not hold (photo versions before the anchoring
   entry's, the author's did:vh history), and inscribes the whole stored log
   from genesis through the anchoring entry as CBOR metadata, with the current
   photo version as the body under its media type; ord returns exactly those
   entries and bytes (P9.17, P9.18, P14.12; originals-spec #53). Broadcast but unmined, it does not count (P9.4) and reads
   `pending-bitcoin-acceptance`; mined, it reads `anchored` and the Original
   verifies as anchored and current, with provisional ownership of the reveal
   output (P9.11, P9.16). Every read names its index (P9.11).
2. An edit is reinscribed on the same sat, one entry, by spending the output
   that holds it (P9.12, P9.13).
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
8. A second Original with an editor: Bob, granted the resource, makes its next version
   before the anchor; Alice anchors and edits, and Bob edits again, all before
   anything is published. Without Bob's DID history the same store refuses to
   inscribe (`ANCHORING_NOT_VERIFIED`, P9.18). Catching up inscribes the log
   through the anchoring entry (Bob's entry inside it; ord returns the exact
   stored entries as metadata and the current version as the body), labelled pending until mined (asking for the edit first is
   `HEAD_NOT_NEXT`), then Alice's edit, then Bob's editor entry, which the
   holder inscribes and Bitcoin accepts, each in a later block (P5.16, P9.12,
   P9.13).
9. Fresh readers: each Original verifies from its sat alone, with no copy of
   the log, given only the off-chain signer DID histories; the current version
   is read from the newest accepted inscription's body and verified, earlier
   uninscribed versions are unavailable, not a failure, and without the editor's history identity
   evidence is incomplete (P9.17, P9.18). A recipient of the second sat, with
   an empty store, verifies the sender's `transferHandoff` package against the
   sat (`verifyHandoff`): anchored, identity complete, resources available.
11. Read budgets (step 10, chain order after an unverifiable inscription, is
    described in the script's header): the holder adds two ordinary
    20,000-byte images to the second Original's sat, one with a collection's
    CBOR map metadata and one with none. A full read with a one-byte content
    budget still verifies the Original as anchored: each image is judged by its
    metadata (`not-requested`) and ignored, and the Originals inscriptions are
    read from the Originals pool. An Originals read passed through the host's
    JSON codec and the landing's decoder keeps the image's metadata as bytes
    and verifies. A read whose Originals pool cannot hold the first inscription
    stops asking for metadata, reports it unknown, and is
    `SAT_READ_INCOMPLETE`, never a wrong result (P9.12, P9.17, P14.12).

The recovery store in this journey is in memory: step 7 shows resuming within
one process. The restart journey below shows it after a process is killed.

The restart journey (#975) keeps every store on disk in one temporary
directory: the Original in a `FileStore`, the writer's signed pairs in a
`fileRecoveryStore` (both from `@originals/sdk/originals/fs`). Each process
after the first is `scripts/regtest/originals-writer-child.ts`, started with
only the store paths and the local node's endpoints in its environment.

1. The journey creates an Original, anchors it and inscribes the log through
   the anchoring entry (unmined, it does not count and reads
   `pending-bitcoin-acceptance`; mined, `anchored`, and ord returns the exact
   stored genesis and anchoring entries as metadata, with the resource as the
   body), then edits it with the resource's next version.
2. A writer process prepares and submits the edit's pair. When the state
   machine asks to broadcast the reveal (the commit is out and the record says
   `reveal_broadcast_unknown` on disk) the writer reports that, re-read from
   the record file, and sends nothing more; the journey checks the reveal is
   not in the mempool and kills it with SIGKILL.
3. With the commit mined and the reveal not, a fresh process reads Bitcoin:
   the accepted head is still the anchoring entry, and `catchUp`, listing the
   recovery store itself, says resume (P9.4, P9.6).
4. Another fresh process resumes: the same commit txid, reveal txid and
   inscription id. Until the reveal is mined the head is unchanged and
   `catchUp` waits; once mined, the head is the edit, through that
   inscription.
5. A fresh reader, with a new empty store and no author list, given only the
   did:btco sat and the evidence package the author exported, checks author
   binding, the history before the anchor, the accepted Bitcoin head, the
   exact resource bytes, the network, the confirmation depth (3) and the trust
   boundary (one ord index, reported; ownership provisional; uniqueness not
   established). Freshness is reported as not established, so the reader does
   not claim the result current. The same reader also verifies from the sat
   alone, with no copy of the log and only the package's author DID history:
   the anchor, the resumed inscription and a valid history to the edit, with
   the current version read from the resumed inscription's body (P9.17,
   P9.18).

It writes a receipt (git revision, Core and ord versions, txids, inscription
ids, process ids and signals, store paths, PASS or FAIL per check) to
`$ORIGINALS_REGTEST_RESTART_EVIDENCE` when set, and then keeps the store
directory; under the runner, `REGTEST_RECEIPT` gives
`<receipt>-originals-restart.json`.

`REGTEST_RECEIPT=/absolute/path/receipt.json` writes receipts (the Originals
journey writes `<receipt>-originals.json`), and `REGTEST_LOGS_DIR` keeps the Core
and ord logs. Set both `BITCOIND_BIN` and `ORD_BIN` to use installed binaries.
The runner uses no public Bitcoin network and spends nothing outside regtest.

`originals-evm-move.ts` (EXPERIMENTAL, originals-spec PR 59) adds a local
anvil devnet (Foundry; `--slots-in-an-epoch 1`, so `finalized` trails `latest`
by two blocks) to the same Core and ord. It deploys `contracts/OriginalsAnchor.sol`
through the deterministic deployment proxy with a zero salt (P14.21) and pins
the devnet as an `operator` chain. Each step is asserted on real transactions:

1. Created with an `anchor` member after the genesis notice (P9.27), anchored,
   minted and published on the token: `pending-evm-finality`, then final,
   anchored and current, attested by the operator (P9.22, P9.23).
2. An edit is published on the token and verifies as current (P9.20).
3. A move entry to a sat the wallet holds (P9.28), after the P9.29 notice
   (Bitcoin, irreversible, no layer above). The Bitcoin writer refuses the
   arrival before the departure is published (`EVM_DEPARTURE_NOT_FINAL`).
4. The departure on the token: while above the finalized block the arrival is
   still refused (`EVM_DEPARTURE_NOT_FINAL`) and the token writer waits
   (`EVM_PUBLICATION_PENDING`); final, the token writer refers the arrival to
   the Bitcoin writer (`EVM_ARRIVAL_ON_BITCOIN`). Read from the token alone the
   arrival is unknown; with the sat read, departed and not arrived.
5. The arrival inscription carries the whole log through the move entry, with
   the current version as its body; ord returns exactly those entries. Unmined
   it is `pending-bitcoin-acceptance`; mined, anchored on Bitcoin,
   `moved-to-bitcoin` with the move confirmed, no EVM owner, ownership of the
   reveal output, and the move entry keeps the operator stretch's ordering.
6. Bitcoin is terminal: no token publication and no further move
   (`MOVE_NOT_FROM_EVM`); a later edit is reinscribed on the sat.
7. A fresh reader with no copy of the log, given the sat read, the token read at
   its finalized block and the author's DID history, verifies the five entries:
   anchored on Bitcoin, the token's stretch accepting the anchoring entry, the
   edit and the move entry in order, genesis carried with claimed ordering,
   ownership of the sat holder's output. Without the token read the move is
   unconfirmed, with no owner and not current (P9.29, C12-273).

Its receipt is `$ORIGINALS_REGTEST_EVM_EVIDENCE`, or
`<receipt>-originals-evm-move.json` under the runner.

`landing-anchor.ts` runs the landing's path (plan 011 PR 10b) on the same
nodes. The server is `apps/landing/serve.ts`, a child process with
`ORIGINALS_BITCOIN_ANCHORING=1`. The browser is the landing's own `DemoEngine`
in the runner, over HTTP. The journey covers:
- the anchor;
- a reinscription of the Original's own sat;
- the server SIGKILLed between commit and reveal (a Core RPC proxy holds the
  reveal), and a fresh process resuming the identical reveal while the
  browser's retry is answered from the record;
- a reorg out and back;
- a fresh reader.

Its receipt (`$ORIGINALS_REGTEST_LANDING_EVIDENCE`, or
`<receipt>-landing-anchor.json` under the runner) labels the local author and
commit keys as not Turnkey. `landing-live.ts` is the owner-run, interactive
stage A of #975, with a real Turnkey session in a real browser. See
[`docs/regtest/originals-live-acceptance.md`](../../docs/regtest/originals-live-acceptance.md).

The signer is a disposable local key (the restart receipt says
`signer: local-disposable-key (not Turnkey)`). This proves the transaction
path, not a live Turnkey call, a hosted deployment or mainnet; live
client-authorized signing and the owner's mainnet release proof are separate.
