---
"@originals/sdk": patch
"@originals/auth": patch
---

Batch of verification, event, and provider hardening fixes:

- `Verifier.verifyCredentialMultiSig` now enforces the credential validity window and fails closed on (or resolver-checks) a declared `BitstringStatusListEntry`, so expired/revoked multi-sig credentials no longer verify (#340).
- `CredentialManager.verifyCredentialWithStatus` returns `verified: false` for revoked/suspended credentials; `checkRevocationStatus`/`isRevoked` reject a status list whose `id` doesn't match the credential's reference and document that they trust the caller-supplied list (#345).
- Status-list trust validation (id match, proof verification, issuer equality) is now a single shared implementation used by both Verifier and CredentialManager (#301).
- Fail-closed signing refusals key on typed `StructuredError` codes (`ISSUER_BINDING_MISMATCH`, `VM_RETIRED`) instead of error-message wording (#309).
- `asset:migrated`/`asset:transferred` are mirrored onto the LifecycleManager emitter so `sdk.lifecycle.on(...)` subscriptions and built-in EventLogger metrics fire; `verification:completed` and `batch:progress` are now actually emitted (#346, #352).
- `Logger.sanitize` is cycle-safe and cannot crash the calling operation; `FileLogOutput` retains batches on failed writes and flushes on process exit (#349, #352).
- `SignetProvider.estimateFee` fails loudly instead of fabricating an inverted fallback rate; regtest commit change outputs accept testnet-format addresses like the transfer path; cost quotes apply the `MAX_REASONABLE_FEE_RATE` cap (#351).
- QuickNodeProvider: optional `expectedNetwork` chain check, explicit `contentEncoding` option, txid/inscriptionId/sat shape validation before provenance, content-unavailable distinguished from nonexistent, endpoint token redacted from errors (#350).
- Prerelease versions no longer pass the pichu/cleffa release gates; Multikey decode validates key lengths; 33-byte "prefixed Ed25519" keys are rejected instead of guessed at; JWT verification pins HS256 and requires a ≥32-char secret (#352).
- Cross-network `did:btco` guard runs before the DID cache read; LRU eviction no longer deletes entries from persistent cache storage; `addResourceVersion` types `newContent` as `string` (#312, #313, #311).
