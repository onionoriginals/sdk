---
'@originals/vh': minor
'@originals/sdk': minor
---

Experimental: carried logs and EVM anchoring, built to originals-spec PR 59
(`ce19572`, with the owner decisions of 13 and 14 November 2026). Everything EVM is
unsupported by default, because the spec pins no anchor contract (P14.21).

- Carried logs (P7.11–P7.16, P14.14–P14.17): `readCarriedFile`,
  `writeCarriedFile`, `carriedDisclosure` and `locateCarrier` in
  `@originals/vh/originals`, and `carry`, `readCarried` and `importCarried`
  on the SDK. A reader resolves signer DIDs only on an explicit
  `resolveSigners` opt-in, which applies to that single read: there is no
  standing opt-in, and importing never counts as one (P7.13). The text-block
  writer places a block only where the version's own parser reads it as a
  comment, and refuses a syntax it has no parser for (`no-parser`, P14.16).
- EVM anchoring (P3.9, P9.19–P9.29, P14.18–P14.22): the `anchor` member and
  move entries, the listed chains and their trust classes, `verifyOriginal`'s
  `evm` option and the `evm` report section, and `resolveDidEvm`. The SDK
  adds a JSON-RPC reader and a writer that uses a wallet you supply, from
  `@originals/sdk/originals/evm`.
  - A writer refuses an `anchor` member unless it is given an `EvmAnchorPin`.
  - Chains (P14.22; owner decision, 14 November 2026): `EVM_CHAINS` lists
    one chain, Base (`eip155:8453`, `exit-protected`, proven). An `anchor`
    member naming any other chain, including the seven the first list named
    (Ethereum, Monad, Arbitrum One, Arc, Tempo, Robinhood Chain, Elysium), is
    unsupported, not invalid, and a writer refuses it
    (`EVM_CHAIN_NOT_LISTED`). An Original on Base moves only to Bitcoin: a
    move entry naming Base again is a same-layer move (`STATE_MOVE_LAYER`),
    and one naming an unlisted EVM chain is unsupported. The trust classes,
    layers and moves between EVM chains are kept for a later revision; an
    `EvmAnchorPin`'s `chains` can list devnet chains for an experiment.
  - `OriginalsSDK` takes an `evm` option (`pin`, `providers`, `fetch`).
    `create` takes `anchor` with the acknowledged P9.27 notice
    (`acknowledged`). `anchor()` lists the token alias. `mintEvm`,
    `prepareEvmPublication`, `submitEvmPublication` and
    `evmPublicationStatus` publish on the token, one publication at a time,
    after verifying the log through the entry published (P9.18).
    `prepareMove` and `move` write a move entry up a layer (P9.28, P9.29).
    `verifyCommitted` verifies the committed log through a checkpoint as a
    local copy. `get`, `load` and `carry` read the configured providers or
    take `evm` reads; with no token readable, `get` reports missing evidence
    and at most the entries before the first anchoring entry, never the
    local copy (P7.14, P9.18). A commit is refused when a token accepted an
    entry the local log does not hold (P9.12).
  - Providers (P9.22): one usable provider is enough; a provider failing the
    chain ID or block 0 check, or unable to serve state at the finalized
    block, is dropped and the others' reads stand (`excludedProviders`,
    reason `state-unavailable`), and evidence is missing only when none
    remains. Two usable providers that disagree are missing evidence. Every
    stretch, owner and uniqueness names its `providers` and is marked
    `uncorroborated` when only one answered. The reader reads the remaining
    providers again at their own lower finalized block when an unusable one
    set it.
  - Checkpoints (P9.25): `EvmCheckpoint` is the head entry's versionId with
    `chain`, `contract`, `tokenId`, `record` (the accepting record's index),
    `block` and `class`, plus PROVISIONAL record placements; it holds no
    entries. `isEvmCheckpoint` and `resumableCheckpoint` decide whether a
    retained value is one and whether a log (entry N is its head) resumes
    from it; a read resumes after its record index. None is made while a
    publication waits on an unverifiable entry. Checkpoints retained in the
    earlier format are dropped.
  - Stores may keep retained EVM blocks and checkpoints (`getRetainedEvm`,
    `putRetainedEvm`; `MemoryStore` and `FileStore` do).
  - The Bitcoin writer inscribes an Original that moved from an EVM chain
    only once its departure is accepted and final, then verifies the log
    through the move entry as a local copy (P9.18, P9.29).
  - `verifyOriginal`'s `evm` evidence takes `localCopy` (P9.18): with no
    token read, the writer's own committed log verifies whole, unverified on
    the chain and never current, marked `evm.localCopy` with the reason
    `local-copy`; it is only the writer's own check before publishing and
    never a report for anyone else. When evidence for the current anchor is
    missing, `evm.notCheckedAgainstAnchor` lists the entries from the first
    anchoring entry on (P7.14, P9.29).
  - A verifier given no pin reports the Original unsupported, where it used
    to report it valid as of its checkpoint.
- Breaking: the 65,536-byte entry limit is measured over the entry's JCS form
  in UTF-8 in every format (P14.13), not over the stored line. `verifyLog` no
  longer takes `lineBytes`.
