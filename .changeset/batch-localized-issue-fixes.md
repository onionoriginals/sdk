---
"@originals/sdk": major
"@originals/auth": patch
---

Resolve a batch of 11 localized bug/security/infra issues across VC, Bitcoin, DID, CEL, lifecycle, and migration. Two changes are breaking.

**BREAKING — `transferInscription` returns only provider-attested data (#290):** `BitcoinManager.transferInscription` no longer mutates the caller's inscription object (`inscription.satoshi = …`) and no longer fabricates a `vin` from the caller's stale txid/vout or a dust-valued `vout` when the provider omits outputs. Unknown inputs/outputs are surfaced as empty arrays. Callers that read the fabricated `vout[0]` or relied on the input being mutated must adjust.

**BREAKING (emit side) — CEL `digestMultibase` is now a spec-conformant multihash (#258):** `computeDigestMultibase` prepends the sha2-256 multihash header (`0x12 0x20`), so newly written `previousEvent` chain links and external-reference digests are Multibase-encoded Multihashes interoperable with other CEL implementations. The **read path is tolerant**: `decodeDigestMultibase`, `verifyDigestMultibase`, and event-log/witness verification (via the new exported `digestMultibaseEquals`) accept both the multihash form and the legacy bare-digest form, because logs anchored on Bitcoin in the old format are immutable and cannot be recomputed. Mixed-format chains (old events legacy, new events multihash) verify correctly; other CEL implementations will still reject the legacy-format links, so recompute/re-anchor where interop matters.

Fixes:

- **vc (#289):** `StatusListManager.setStatus`/`batchSetStatus` strip any stale `proof` from the returned credential (the updated bitstring invalidates the old signature, forcing a re-sign); `Verifier.verifyCredential` stops stringifying an inline-object `@context` into `"[object Object]"` (which caused spurious `verified:false`); `BBSCryptosuiteUtils.parseBaseProofValue` rejects the derived-proof header `0x03` instead of misparsing it as a base proof.
- **bitcoin (#290):** `selectUtxos` funds a changeless transaction instead of throwing `INSUFFICIENT_FUNDS` when the accumulated amount covers a single-output spend but not a two-output one.
- **lifecycle (#273):** `transferOwnership` resolves the real inscription on the satoshi via the provider (new `BitcoinManager.getInscriptionIdBySatoshi`) and throws `INSCRIPTION_NOT_FOUND` rather than fabricating an `insc-<sat>`/`unknown-tx` inscription into provenance.
- **adapters/security (#265):** `OrdHttpProvider` pins the indexer-supplied `content_url` to `baseUrl`'s origin (SSRF), caps both JSON and content fetches by size, and refuses redirects (`redirect: 'error'`) so a same-origin URL cannot 30x to an internal host.
- **did (#299):** `migrateToDIDWebVH` preserves each source-peer key's `keyAgreement`/`capabilityInvocation`/`capabilityDelegation` relationship (previously dropped, silently breaking encrypted messaging against the migrated DID).
- **migration (#293):** fail-fast batch operations throw a `BatchError` carrying partial results; resource-version numbering honors declared versions and looks up by number; the dead asset-level `asset:created` emit is removed; `getActiveMigrations` returns all non-terminal states (incl. `ANCHORING`); failed-migration audit records the real validation results; `migrateBatch` guards empty input, dedupes DIDs, and honors `maxConcurrent`; `BitcoinValidator` consults the fee oracle/provider and corrects its network warning.
- **infra (#294):** remove a committed TLS private key and ignore `*.pem`/`*.key`; `test:ci` uses `pipefail` so failing tests aren't masked by coverage; prune dead dependencies; `loop.sh` uses `pipefail`; document the real `release.yml`; add `"./package.json"` to package exports; `OriginalsSDK.create` derives the webvhNetwork tier from an explicit Bitcoin `network` (regtest→magby, signet→cleffa, mainnet→pichu) instead of silently targeting the production `pichu` domain.
- **chore (#284, #285):** delete dead Railway/Nixpacks deploy config referencing a removed app, and remove the orphaned `server/`/`shared/` directories (undeclared deps + a plaintext key store).
