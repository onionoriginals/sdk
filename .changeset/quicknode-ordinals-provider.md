---
"@originals/sdk": minor
---

Add `QuickNodeProvider`, a production `OrdinalsProvider` backed by a QuickNode Bitcoin endpoint with the Ordinals & Runes add-on. Supports inscription/sat reads (`ord_getInscription`, `ord_getContent`, `ord_getSat`), transaction broadcast (`sendrawtransaction`), confirmation status (`getrawtransaction` + `getblockheader`), and fee estimation (`estimatesmartfee`, converted to sat/vB). Inscription creation/transfer fail loudly since QuickNode does not build or sign transactions — build locally and submit via `broadcastTransaction`. `createOrdinalsProviderFromEnv()` now selects this provider when `QUICKNODE_ENDPOINT` is set.
