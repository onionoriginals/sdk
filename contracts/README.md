# Originals anchor contract — EXPERIMENTAL

> **EXPERIMENTAL. NOT REVIEWED. NOT AUDITED. NOT THE P14.21 PIN.**
>
> This is a test implementation of the anchor contract proposed in
> originals-spec PR 59 (head `a3ffdc1`), P14.19–P14.21. The spec pins no
> contract, compiler, EVM version, address or code hash yet. An Original
> anchored on a deployment of this code is supported only by an experiment
> that supplies its own `EvmAnchorPin` (`@originals/vh`). Nothing built on it
> supports an interoperability claim. Do not deploy it to any public chain.

`src/OriginalsAnchor.sol` implements, on a self-contained minimal ERC-721:

- `mint(bytes32 original)`: mints `uint256(keccak256(abi.encode(original, msg.sender)))`
  to the caller, and reverts if that token exists (P14.19).
- `publish`, `publishSameBody`, `begin`/`append`/`commit`/`commitSameBody`,
  `publicationCount`, `publication`, and ranged `metadata`/`body` reads, and the
  `Published` and `UploadBegun` events, exactly as P14.20 declares them.
- A record that refers to an earlier body (`publishSameBody`, `commitSameBody`)
  holds that body's length as its `bodyLength`, and only its newly stored
  metadata counts toward the limit. `bodyOf` indexes the selected token's own
  records, so another token's body can never be selected (P14.20).
- Bytes stored as the code of contracts it creates (SSTORE2 style). Each
  contract's code is a zero byte (STOP) followed by at most 24,575 bytes
  (EIP-170). The anchor keeps their addresses in storage. The contract emits
  no publication bytes in events.
- The limits: 350,000 bytes per publication and per upload, and 255 bytes per
  media type. Only, at that moment, the token's holder, the address approved
  for it through `approve`, or an operator the holder approved through
  `setApprovalForAll` can publish, begin or commit (P9.23, P14.20). Only the caller of `begin` can
  `append` or `commit`, and an upload can be committed only once.
- `tokenURI` is a `data:` URI computed from the contract's own state (P14.21).
  It is never the did:evm DID document (P3.9).
- No owner, administrator, proxy, upgrade, pause or self-destruct path (P14.21).

`begin` emits `event UploadBegun(uint256 indexed tokenId, bytes32 upload, address by)`
(P14.20, added at `a3ffdc1` from finding 2 below), because a transaction's
return value cannot be observed off chain. Like `Published`, it is a discovery
aid and never evidence.

## Build settings (this experiment's choices, PROVISIONAL)

| Setting | Value |
|---|---|
| Compiler | solc 0.8.38 (latest release on 11 November 2026) |
| EVM version | `cancun` (chosen as the common denominator the listed L2s support; P14.21 must pin one) |
| Optimizer | on, 200 runs, legacy pipeline (`via_ir = false`) |
| Metadata | `bytecode_hash = "none"`, `cbor_metadata = false`, so the bytecode depends only on source and settings |
| Toolchain | Foundry 1.9.0 (`6056c58`) |
| Dependencies | none (tests declare the cheatcodes they use in `test/Base.sol`; no forge-std) |

## Deterministic deployment (P14.21)

The contract is deployed by CREATE2 through the deterministic deployment proxy
`0x4e59b44847b379578588920ca78fbf26c0b4956c` with a zero salt. The call data
is 32 zero bytes followed by the init code.

| | |
|---|---|
| Init code hash | `0xadd0b6e6fa707ff1c7738cc5b029a5f4bd4c397b9851c7ad507a496894717b00` |
| CREATE2 address | `0x48f382c1d6c079bde4971c89e316841d2c9e79c2` |
| Runtime code hash (keccak256) | `0x0a97a92302c38e4084f1d15ea5ff08fa8892f3161a54aa63e650f62a8f3f05f0` |
| Runtime code size | 8,857 bytes |

`test/Deploy.t.sol` asserts the address and logs both hashes. The same address
and code hash came out of anvil, which predeploys the proxy. Any change to the
source or settings changes all three. The values above are for the build at
PR 59 `a3ffdc1`, whose `UploadBegun` changed from the earlier build's
(`0x92aa…8b08` at `3ed0f89`).

P14.21 (from `a3ffdc1`) allows a pinned address per chain where the proxy is
unavailable or the pinned bytecode cannot be deployed through it. The runtime
code hash stays common. `EvmAnchorPin.addresses` (`@originals/vh`) carries such
a map, with `address` as the default.

## Gas (anvil 1.9.0, hardfork `Bpo1`, receipts' `gasUsed`)

| Transaction | Gas used |
|---|---|
| Deployment through the proxy | 1,972,407 |
| `mint` | 68,595 |
| `publish`, 2,000 B metadata + 100,000 B body (102,276 B of calldata) | **22,518,216** |
| `publish`, 2,000 B metadata + 60,000 B body | 13,737,056 |
| `publish`, 2,000 B metadata + 1 B body | 643,823 |
| `publishSameBody`, 2,000 B metadata | 567,245 |

Each stored byte costs about 220 gas. Most of that is the 200 gas per byte of
code deposit; calldata and copying make up the rest. A 350,000-byte
publication therefore costs about 77M gas.

The 100 kB `publish` **does not fit in one Ethereum transaction**. EIP-7825
(Osaka/Fusaka) caps a transaction at 16,777,216 gas, and anvil with
`--enable-tx-gas-limit` rejects that `publish`, while the 60 kB one passes.
Under that cap a single transaction can store at most about 74 kB, so larger
publications must use `begin`/`append`/`commit`. The SDK writer defaults to
staging any payload over 60,000 bytes.

Execution gas measured inside forge (`test_gas_publish100kBAndSameBody`, no
intrinsic costs) is 22.7M for the 100 kB publish, 0.59M for `publishSameBody`,
and 0.44M for a `body()` read of 100,000 bytes. Reads are free in `eth_call`,
but they still count against a provider's `eth_call` gas cap.

## Commands

```sh
curl -L https://foundry.paradigm.xyz | bash && foundryup   # local tooling only
cd contracts
forge build
forge test -vv          # 23 tests; Deploy.t.sol logs the address, hashes and gas
```

The SDK's end-to-end test (`packages/sdk/tests/integration/evm-anvil.test.ts`,
`bun run --cwd packages/sdk test:evm-anvil`) deploys this build through the
proxy on a fresh anvil and publishes through the SDK writer. The SDK's `test`
script includes it, but it skips unless `anvil` is on the PATH or in
`~/.foundry/bin` (CI has neither), and it always skips with
`ORIGINALS_EVM_ANVIL=0`.
Gas it measured at the `a3ffdc1` build (sums over each publication's transactions):

| Publication through the SDK writer | Transactions | Gas used |
|---|---|---|
| Anchoring publication: 2 entries + 20 kB body | `publish` | 5,004,151 |
| One entry + 100 kB body, over the 60,000-byte budget | `begin`, 2 `append`, `commit` | 22,446,773 |
| A 30,000-byte entry that keeps the body, 24,000-byte budget | `begin`, 2 `append`, `commitSameBody` | 6,864,309 |
| A name-only entry, about 30 kB because it carries the whole asset state | `publishSameBody` | 6,696,864 |

## Spec findings (originals-spec PR 59, `3ed0f89`)

Findings 1–9 were triaged into PR 59 `a3ffdc1`: 1 and 7 (staging, cost of
full-state entries) as P14.20 text and P9.27 disclosures; 2 as the
`UploadBegun` event; 3 as both approvals named; 4 as resumable checkpoints
with no record cap (P9.25); 5 as P9.22's provider requirement; 6 as a
per-chain address (P14.21); 8 as P9.23's open-minting statement; 9 as the
reworded C12-260 row. They are kept below as found.

1. **P14.20 / P9.25: one `publish` cannot carry 350,000 bytes on real
   chains.** Storing a byte as code costs about 220 gas, so a 350,000-byte
   publication needs about 77M gas. EIP-7825 (live on Ethereum since
   Fusaka) caps a transaction at 16,777,216 gas, which is about 74 kB.
   Geth's pool also refuses transactions over 128 KiB. Staging covers this
   but is the normal path on Ethereum, not the exception. *Fix:* say so in
   P14.20, and state the per-byte cost so writers size `append` by gas, not
   by calldata alone.
2. **P14.20: `begin`'s upload ID cannot be learned.** A transaction's return
   value is not in its receipt, so a writer cannot read the ID `begin`
   returns. It can only guess by simulating, which races with other callers.
   *Fix:* add `event UploadBegun(bytes32 indexed upload, uint256 indexed
   tokenId, address indexed opener)`, as this contract does (PROVISIONAL).
   An alternative is a caller-chosen salt, `begin(uint256 tokenId, bytes32
   salt)`, with `upload = keccak256(abi.encode(tokenId, msg.sender, salt))`.
3. **P14.20 / P9.23: "an operator approved for it" is ambiguous.** ERC-721
   has two approvals: `approve` for one token and `setApprovalForAll` for an
   operator. *Fix:* name both, as ERC-721's own transfer rule does. This
   contract accepts both (PROVISIONAL).
4. **P9.25: a holder can make resolution arbitrarily expensive.** Records per
   token have no limit, and a verifier MUST read every record and its bytes
   and MUST NOT decide on part of them. The token's holder or an approved
   operator can keep adding cheap `publishSameBody` records, and on a cheap
   L2 that costs little. That does not change the result, but it can make a
   token impractical to verify, which undercuts "a holder can therefore not
   stop an Original's earlier accepted history from resolving". *Fix:* let a
   verifier stop at a stated record budget with missing evidence (never
   invalid), or cap records per token in the contract (for example 2^16).
   Alternatively, after a departure is accepted (P9.29), let the verifier
   read later records' fields only.
5. **P9.22: reading state at the finalized block needs archive-depth
   state on rollups.** `eth_call` at a block hash (EIP-1898) works on any
   node, but only for blocks whose state the node still keeps. Full nodes
   typically keep about 128 blocks. On Ethereum, finalized is about 64–95
   blocks behind, which is fine. On rollups such as Arbitrum or Base,
   finalized can trail by tens of minutes to hours, which is thousands of
   L2 blocks. *Fix:* say in P9.22 that providers need state at the finalized
   block (archive or long state retention), and that a provider without it
   is missing evidence.
6. **P14.21: one bytecode and one address on every chain is a strong
   assumption.** The same CREATE2 address needs identical init code, so a
   single EVM version must run on all listed chains (this build uses
   `cancun`). The proxy at `0x4e59…956c` also has to exist on each chain. It
   is deployed by a pre-EIP-155 keyless transaction, which some nodes and
   chains refuse, and chains with their own fee or transaction models (Tempo,
   Arc) may not have it. *Fix:* P14.21 should name the EVM version as the
   lowest common one. It should record, per P14.22 row, that the proxy
   exists, or name a fallback factory, and keep the address per chain if it
   must differ.
7. **Every edit stores the whole asset state again.** Publication metadata is
   complete entries (P14.12, P9.25), and each entry carries the full asset
   state. An Original with 30 kB of metadata pays about 6.7M gas for every
   later entry, even a rename (measured above). That is intended, but it is
   the dominant cost on EVM chains and should be stated in P9.27's
   disclosures or in P14.20.
8. **P14.19: anyone can mint tokens in the collection.** `mint` accepts any
   `original` from any caller, so marketplaces will show tokens that are not
   any Original's token, with arbitrary publications. Only a verifier can
   tell them apart. That is by design (P9.23), but a wallet or marketplace
   user cannot tell. *Fix:* state it, and keep `tokenURI` from implying
   validity. This contract's `tokenURI` gives only the index and count.
9. **P14.20 conformance row "a record of another token".** Indexes are per
   token, so the contract cannot even name another token's record. The row
   is vacuous for the contract. *Fix:* reword it as "an index that is not an
   earlier record of the same token".
