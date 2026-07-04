---
"@originals/sdk": major
---

Fix all open critical- and high-severity issues (#236–#256). Several are breaking.

**BREAKING — CBOR encoder replaced (#236, critical):** `cbor-js` (which silently corrupted strings containing U+E000–U+FFFF and allowed `__proto__` prototype pollution on decode) is replaced by `cborg`. CBOR byte output for previously mis-encoded strings changes; decode now rejects malformed input instead of returning garbage.

**BREAKING — rollback honesty (#237, critical):** `RollbackManager` reports `PARTIALLY_ROLLED_BACK` (success: false) with an `irreversibleArtifacts` list for Bitcoin-targeted migrations instead of unconditional success. New `MigrationStateEnum.PARTIALLY_ROLLED_BACK` terminal state; `MigrationResult.rollback` carries the rollback outcome.

**BREAKING — migrateToDIDWebVH creates real DIDs (#245):** peer→webvh migration now goes through didwebvh-ts `createDID`, producing a spec-valid `did:webvh:{SCID}:{domain}:{slug}` with a signed log (previously an unresolvable rename). New `migrateToDIDWebVHDetailed` returns the log/keyPair/logPath. `saveDIDLog` parses SCID-first DIDs and lays logs out to mirror the resolution URL (#246).

**BREAKING — publishToWeb requires storage (#244):** throws `STORAGE_REQUIRED` when no adapter with `put`/`putObject` is configured instead of silently discarding content into a throwaway in-memory adapter.

**BREAKING — OrdinalsClient fails loudly (#248):** `broadcastTransaction`/`getTransactionStatus`/`estimateFee` throw `NOT_IMPLEMENTED` structured errors instead of fabricating success values.

Security and correctness fixes:

- #238: status list credentials are validated (id binding, own proof, issuer match) before their bits decide revocation — closes a revocation bypass.
- #239: multi-sig signing now emits standard Data Integrity (`eddsa-rdfc-2022`) proofs and verification is DI-only in both `MultiSigManager.verifyMultiSig` and `Verifier.verifyCredentialMultiSig` — the legacy digest proof format is gone entirely (Ed25519 signer keys required); non-did:key signers resolve via DIDManager, and `did:key` verification methods resolve offline through the document loader.
- #240: CEL witness proofs are verified against the digest the witness actually signed; honest witness attestations now report `verified: true`.
- #247: explicit `config.network` takes precedence over the webvhNetwork mapping for did:btco identifiers; lifecycle bindings are network-prefixed.
- #249: `selectUtxosSimple` and `PSBTBuilder` exclude inscription-bearing/resource/locked UTXOs by default (opt-in `allowOrdinalUtxos`).
- #250: `decodeBase64UrlMultibase` validates the base64url alphabet strictly (proofValue malleability).
- #251: `LocalStorageAdapter` rejects domains (e.g. `..`) that resolve outside `baseDir`.
- #254: `migrate({ estimateCostOnly: true })` returns an estimate without executing a paid migration.
- #255: concurrency guards reject concurrent migrate/inscribe/publish of the same asset or DID (double-pay protection); batch validation flags duplicate assets (#243).
- #256: `inscribeData` throws `ORD_SATOSHI_UNKNOWN` (carrying inscription details) instead of returning an empty satoshi; callers no longer fabricate did:btco identifiers from txids.
- #252/#253: npm publish works again (`--provenance` moved to `NPM_CONFIG_PROVENANCE`); the test setup preload now applies in CI and per-package runs.
