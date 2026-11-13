---
'@originals/vh': minor
'@originals/sdk': minor
---

Experimental: carried logs and EVM anchoring, built to originals-spec PR 59
(`a3ffdc1`). Everything EVM is unsupported by default, because the spec pins
no anchor contract (P14.21).

- Carried logs (P7.11–P7.16, P14.14–P14.17): `readCarriedFile`,
  `writeCarriedFile`, `carriedDisclosure` and `locateCarrier` in
  `@originals/vh/originals`, and `carry`, `readCarried` and `importCarried`
  on the SDK. A reader resolves signer DIDs only on an explicit
  `resolveSigners` opt-in, and importing is not an opt-in.
- EVM anchoring (P3.9, P9.19–P9.29, P14.18–P14.22): the `anchor` member and
  move entries, the listed chains and their trust classes, `verifyOriginal`'s
  `evm` option and the `evm` report section, and `resolveDidEvm`. The SDK
  adds a JSON-RPC reader and a writer that uses a wallet you supply, from
  `@originals/sdk/originals/evm`.
  - A writer refuses an `anchor` member unless it is given an `EvmAnchorPin`.
  - `OriginalsSDK` takes an `evm` option (`pin`, `providers`, `fetch`).
    `create` takes `anchor` with the acknowledged P9.27 notice
    (`acknowledged`). `anchor()` lists the token alias. `mintEvm`,
    `prepareEvmPublication`, `submitEvmPublication` and
    `evmPublicationStatus` publish on the token, one publication at a time,
    after verifying the log through the entry published (P9.18).
    `prepareMove` and `move` write a move entry up a layer (P9.28, P9.29).
    `verifyCommitted` verifies the committed log through a checkpoint as the
    local log. `get`, `load` and `carry` read the configured providers or
    take `evm` reads. A commit is refused when a token accepted an entry
    the local log does not hold (P9.12).
  - Stores may keep retained EVM blocks and checkpoints (`getRetainedEvm`,
    `putRetainedEvm`; `MemoryStore` and `FileStore` do).
  - The Bitcoin writer inscribes an Original that moved from an EVM chain
    only once its departure is final, and verifies it as the local log.
  - `verifyOriginal`'s `evm` evidence takes `localCopy`: with no token read,
    the caller's own committed log verifies whole, unverified on the chain
    and never current, as the Bitcoin assembly treats a log with no Bitcoin
    evidence.
  - A verifier given no pin reports the Original unsupported, where it used
    to report it valid as of its checkpoint.
- Breaking: the 65,536-byte entry limit is measured over the entry's JCS form
  in UTF-8 in every format (P14.13), not over the stored line. `verifyLog` no
  longer takes `lineBytes`.
