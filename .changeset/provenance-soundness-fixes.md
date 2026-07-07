---
"@originals/sdk": patch
---

Three provenance/money-safety fixes:

- Verify inline resource content against its declared hash in `createAsset`, `publishResources`, and `inscribeOnBitcoin`, rejecting with `RESOURCE_HASH_MISMATCH` before anything is written, attested, or inscribed (#347).
- SSRF-harden `OrdinalsClient` (the SignetProvider read path): pin indexer-supplied `content_url` to the configured endpoint's origin, refuse redirects, bound request time, cap response sizes, and cap/batch per-satoshi content downloads (#343).
- Size transaction inputs by script class (P2WPKH 68 vB, P2TR 57.5 vB, P2WSH a conservative 120 vB) and outputs by destination address class in all fee estimators, so P2WSH-funded commits no longer underpay the requested fee rate and stall (#344).
