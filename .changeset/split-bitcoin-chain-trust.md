---
"@originals/sdk": patch
"@originals/cel": patch
---

**Bitcoin sat resolution now distinguishes independently node-validated chain facts from a single provider's own assertion (#594).**

`QuickNodeProvider` (the real mainnet `OrdinalsProvider`) serves both the Ordinals/indexer view and the Bitcoin chain view (`getblockchaininfo`, `getblockhash`, `getblock`) from one endpoint. `readSatSnapshot` already cross-checked the ord index tip against the Core tip, but when both come from the same operator/infrastructure that cross-check only proves internal self-consistency: a compromised or dishonest endpoint could fabricate a fully self-consistent snapshot.

- `SatSnapshot` (`@originals/cel/v3`) gains an optional `chainEvidence?: { assurance: 'provider-asserted' | 'node-validated'; source?: string }`. `resolveSat()` validates it and threads it into the accepted `SatResolution`, defaulting to `{ assurance: 'provider-asserted' }` when an adapter doesn't set it. Scoped strictly to chain facts (tip, active block hashes, reveal transaction membership) — it never certifies Ordinals enumeration completeness.
- `QuickNodeProvider` gains an optional `independentChainEndpoint`: a separately operated Bitcoin Core RPC endpoint used only to independently re-derive and cross-check the chain tip and each active block's hash/reveal-transaction membership. Agreement throughout yields `chainEvidence.assurance: 'node-validated'`; any disagreement fails the whole snapshot closed with `SAT_SNAPSHOT_CHAIN_DISAGREEMENT` rather than silently falling back to `'provider-asserted'`. An `independentChainEndpoint` identical to `endpoint` is rejected at construction.
- Existing snapshots/providers are unaffected: `chainEvidence` is optional and additive, and behavior is unchanged when `independentChainEndpoint` is not configured.
