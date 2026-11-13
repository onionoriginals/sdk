# EVM-to-Bitcoin move on anvil and regtest, 2026-11-13

EXPERIMENTAL (originals-spec PR 59 at `a3ffdc1`; plan 011 phase 12). This is
real local-chain evidence for the move path: an Original anchored on an EVM
devnet moves up to Bitcoin. It used one disposable anvil devnet and disposable
Bitcoin Core / ord regtest only. No public chain, testnet, mainnet or real
funds were touched. It is not a public-host or mainnet release proof.

## Versions

- Revision `ad51876f` (branch `t3/integrate-spec-pr-59`, draft PR #1061).
- Bitcoin Core v31.1.0 and ord 0.29.0, the pinned regtest installer's archives.
- anvil 1.9.0 (Foundry `6056c584`), chain ID 31337, `--slots-in-an-epoch 1`.
  `finalized` trails `latest` by two blocks, so a publication stays above the
  finalized block until three blocks are mined.
- `contracts/OriginalsAnchor.sol` deployed through the deterministic deployment
  proxy with a zero salt (P14.21) at `0x48f382c1d6c079bde4971c89e316841d2c9e79c2`.
  Its runtime code hash is `0x0a97a923…3f05f0`, matching `contracts/README.md`.
  The devnet is pinned as an `operator` chain.

## Commands

```sh
REGTEST_RECEIPT=/tmp/evm-move-full/receipt.json bun run regtest
# or the journey alone:
BITCOIND_BIN=… ORD_BIN=… ORIGINALS_REGTEST_EVM_EVIDENCE=/tmp/evidence.json \
  bun scripts/regtest/originals-evm-move.ts
```

Both commands passed. The full runner ran every journey with exit 0, and
`scripts/regtest/originals-evm-move.ts` ran after the restart journey. The
receipt is [`receipts/originals-evm-move-2026-11-13.json`](receipts/originals-evm-move-2026-11-13.json).

## What ran, with key IDs

| Step | Result |
|---|---|
| Create with `anchor`, anchor, mint | `did:vh:QmUYuj5xzDi7YjrLHGniM8nKUmJ7SHme5Y92XFTMnvzREX`. Token `did:evm:31337:0x48f3…9c2:5276…8077`. Mint tx `0xf862e3ac…31e5`, held by the anvil minter `0x7099…79c8` |
| Anchoring publication (record 0) | tx `0x57bcd654…ee6b`, carrying entries 1–2. Read `pending-evm-finality` first, then `finalized`: anchored, `evm-attested-by-operator`, current |
| Edit on the token (record 1) | `3-QmV16dDv…jW25`, tx `0xa2994621…4927`. Verifies as current |
| Move entry to `did:btco:reg:9999899718` | `4-QmZjjA6D…Coid`. The P9.29 notice says Bitcoin, irreversible, no layer above. Before the departure was published, the Bitcoin writer refused the arrival: `EVM_DEPARTURE_NOT_FINAL` |
| Departure (record 2) | tx `0x83b0fa17…5484`. Above the finalized block it read `pending-evm-finality`. The arrival was refused again (`EVM_DEPARTURE_NOT_FINAL`) and the token writer was waiting (`EVM_PUBLICATION_PENDING`). Once final, the token writer refused with `EVM_ARRIVAL_ON_BITCOIN`. From the token alone the result was `unverified` with arrival `unknown`. With the sat read it was `departed-not-arrived` / `not-arrived` |
| Arrival inscription | Commit `bd4a99eb…3aeb`, reveal `a2921875…8fd1`, inscription `a2921875…8fd1i0`, height 106. It carries entries 1–4 (3,963 bytes of metadata) and a 4,000-byte body; ord returned exactly the stored lines. Unmined it read `pending-bitcoin-acceptance`. Once mined it read `anchored`, with `moved-to-bitcoin`, move `confirmed`, arrival `arrived` and no EVM owner. Ownership is provisional, `a2921875…8fd1:0`. The move entry keeps `evm-attested-by-operator` ordering |
| Bitcoin is terminal | The token writer refuses. A further move is `MOVE_NOT_FROM_EVM` |
| Edit on the sat | `5-QmaB7Mwq…r4GL`, inscription `6f60f1de…07bdi0`. It carries one entry, by spending the output that held the sat |
| Fresh reader (sat read and token read, no copy) | History valid with 5 entries. Anchored on Bitcoin, `copy: absent`, identity complete, current. The operator stretch lists entries 2, 3 and 4 in order, with the departure at record 2 (finalized block 15). Genesis is carried with claimed ordering. Ownership is `6f60f1de…07bd:0`, which Core reports as the wallet's own address |
| Fresh reader without the token read | Log valid. Move `unconfirmed`, stretch ordering `claimed`, no owner, not current (`move-unconfirmed`) |

## Bugs found and fixed

This run found that a reader with only the destination sat (no copy of the
log, no token read) took the Bitcoin path alone. It reported the arrival
anchored, owned by the sat holder, with `anchored` ordering and current. That
breaks P9.29 / C12-273: a chain the Original left that is not read leaves the
move unconfirmed, with no owner and not current.

With a copy supplied, the same unconfirmed move still reported `anchored`
ordering and a Bitcoin owner. A reader with no copy was also told that a
supplied copy `agrees`.

All three are fixed in `f84242ad` (`packages/vh/src/originals/verify.ts`,
`evm-anchor.ts`), with tests first in `packages/vh/tests/evm-anchor.test.ts`.

## Not covered

- Only one EVM chain (`operator`). The move from a proven chain to Bitcoin, and
  an EVM-to-EVM move followed by Bitcoin, are not on real nodes here. The
  two-devnet EVM move is in `packages/sdk/tests/integration/evm-anvil.test.ts`.
- A reorganisation of the departure's anvil block (P9.22 finality failure)
  and a Bitcoin reorg of the arrival.
- A crash between the arrival's commit and reveal. The Bitcoin writer's
  recovery is the same as in `originals-restart.ts`, but it is not repeated
  for an arrival.
- After the arrival, `prepareEvmPublication` still answers
  `EVM_ARRIVAL_ON_BITCOIN` rather than `MOVED_TO_BITCOIN`, because the token
  writer never reads the sat. It refuses correctly, but the message tells the
  writer to inscribe an arrival that already exists.
- Public chains, Robinhood Chain, real wallets, and mainnet or testnet proof
  are owner release gates.
