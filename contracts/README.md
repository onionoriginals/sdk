# Originals anchor contract — EXPERIMENTAL

> **EXPERIMENTAL. NOT REVIEWED. NOT AUDITED. NOT THE P14.21 PIN.**
>
> This is a test implementation of the anchor contract proposed in
> originals-spec PR 59 (head `3ed0f89`), P14.19–P14.21. The spec pins no
> contract, compiler, EVM version, address or code hash yet. An Original
> anchored on a deployment of this code is supported only by an experiment
> that supplies its own `EvmAnchorPin` (`@originals/vh`). Nothing built on it
> supports an interoperability claim. Do not deploy it to any public chain.

`src/OriginalsAnchor.sol` implements, on a self-contained minimal ERC-721:

- `mint(bytes32 original)`: mints `uint256(keccak256(abi.encode(original, msg.sender)))`
  to the caller, and reverts if that token exists (P14.19).
- `publish`, `publishSameBody`, `begin`/`append`/`commit`/`commitSameBody`,
  `publicationCount`, `publication`, and ranged `metadata`/`body` reads, and the
  `Published` event, exactly as P14.20 declares them.
- Bytes stored as the code of contracts it creates (SSTORE2 style). Each
  contract's code is a zero byte (STOP) followed by at most 24,575 bytes
  (EIP-170). The anchor keeps their addresses in storage. The contract emits
  no publication bytes in events.
- The limits: 350,000 bytes per publication and per upload, and 255 bytes per
  media type. Only the token's holder, or an operator approved for it at that
  moment, can publish, begin or commit. Only the caller of `begin` can
  `append` or `commit`, and an upload can be committed only once.
- `tokenURI` is a `data:` URI computed from the contract's own state (P14.21).
  It is never the did:evm DID document (P3.9).
- No owner, administrator, proxy, upgrade, pause or self-destruct path (P14.21).

It has one PROVISIONAL addition to P14.20's interface:
`event UploadBegun(bytes32 indexed upload, uint256 indexed tokenId, address indexed opener)`.
`begin` returns the upload ID, but a transaction's return value cannot be
observed off chain, so a writer has no other way to learn it (see "Spec
findings" below).

ERC-721 approvals: this contract counts both `setApprovalForAll` operators and
the token's `approve` address as "an operator approved for it" (P9.23,
P14.20). That reading is PROVISIONAL.

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
| Init code hash | `0x89b510251de5f01d616d3af6b84e9c23f8575510aa5a393724fd193a4a0ab625` |
| CREATE2 address | `0x92aa49faf844dee74ab85de1a42a0705e8ea8b08` |
| Runtime code hash (keccak256) | `0x8d731c48c1f0a4f4df923f04141da8ee4cbf9316ab7900d400539a0eb7a994f7` |
| Runtime code size | 8,847 bytes |

`test/Deploy.t.sol` asserts the address and logs both hashes. The same address
and code hash came out of anvil, which predeploys the proxy. Any change to the
source or settings changes all three.

## Gas (anvil 1.9.0, hardfork `Bpo1`, receipts' `gasUsed`)

| Transaction | Gas used |
|---|---|
| Deployment through the proxy | 1,970,235 |
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
forge test -vv          # 20 tests; Deploy.t.sol logs the address, hashes and gas
```

The SDK's end-to-end test (`packages/sdk/tests/integration/evm-anvil.test.ts`)
deploys this build through the proxy on a fresh anvil. It skips unless
`ORIGINALS_EVM_ANVIL=1` and `anvil` is on the PATH, or in `~/.foundry/bin`.
