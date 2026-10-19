---
'@originals/sdk': minor
'@originals/vh': minor
---

Witnessed Originals (plan 011, PR 7a). Authors declare witnesses with an `OriginalsWitnesses` service in their DID document (PROVISIONAL); `verifyOriginal` enforces the witness parameter against that declaration (P9.9), requires threshold witness proofs after activation (P9.8), and reports `ordering: "witnessed"` with `witnessedFrom`. The SDK adds `activateWitnesses`, collects witness approvals on every commit to a witnessed Original, persists witness files, and ships `OriginalsWitness`, a reference witness that enforces the P9.8 obligations.
