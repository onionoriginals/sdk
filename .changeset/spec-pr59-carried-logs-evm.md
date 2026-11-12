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
  - A verifier given no pin reports the Original unsupported, where it used
    to report it valid as of its checkpoint.
- Breaking: the 65,536-byte entry limit is measured over the entry's JCS form
  in UTF-8 in every format (P14.13), not over the stored line. `verifyLog` no
  longer takes `lineBytes`.
