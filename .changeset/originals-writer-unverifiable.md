---
'@originals/sdk': minor
---

The Bitcoin writer treats an inscription it cannot verify for want of the signer DID version it names (`later-inscription-unverifiable`) as not settled (P9.12, P9.15, P5.6): `catchUp` returns the new step `wait-for-evidence` (with `signer` and `signerVersionId`) instead of preparing a replacement for it, and preparing another pair for that entry is refused as `PAIR_IN_FLIGHT` unless `replaces` names it (P9.6). With the evidence supplied, the same inscription is accepted.
