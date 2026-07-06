---
"@originals/sdk": patch
---

Fail loudly instead of fabricating on-chain data in the live Ordinals providers. `OrdHttpProvider` write-path methods (`broadcastTransaction`, `getTransactionStatus`, `estimateFee`, `createInscription`, `transferInscription`) and all `OrdNodeProvider` methods now reject with a `StructuredError` (`*_NOT_IMPLEMENTED`) rather than returning hardcoded placeholder txids, fees, or empty resolution results.
