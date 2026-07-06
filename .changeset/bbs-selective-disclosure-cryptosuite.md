---
"@originals/sdk": major
---

Implement the BBS+ selective-disclosure cryptosuite (`bbs-2023`), replacing the `BbsSimple` stub. `BBSCryptosuiteManager` now signs, verifies, and derives selective-disclosure proofs over real BLS12-381 keys via `@digitalbazaar/bbs-signatures`, with the W3C Data Integrity selective-disclosure pipeline (skolemization, HMAC-shuffled label maps, JSON-Pointer selection) in `vc/utils/selective-disclosure.ts`. Verification keys always resolve from the DID document via the document loader (fail-closed), never from the attacker-controlled proof.

BREAKING: the `BbsSimple` class and its root export (`export { BbsSimple } from '@originals/sdk'`) are removed. It was a non-functional stub that threw from every method; consumers should use `BBSCryptosuiteManager` instead.
