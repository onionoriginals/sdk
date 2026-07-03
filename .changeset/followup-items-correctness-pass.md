---
"@originals/sdk": major
---

Address all deferred FOLLOWUP.md items (1–19): spec-conformance, verification-hardening, and fail-closed fixes. Several are breaking.

**BREAKING — wire format:** `encodeBase64UrlMultibase`/`decodeBase64UrlMultibase` now emit and accept only the spec-correct `u` multibase prefix (previously `z`, which per multibase means base58btc). Legacy-path credential proofValues, MultiSig proofValues, and keyless audit-record integrity hashes produced by older SDK versions no longer verify.

**BREAKING — btco anchoring is now gating:** `verifyEventLog` verifies `bitcoin-ordinals-2024` witness proofs against the chain (inscription exists, sits on the claimed satoshi, content commits to the event digest) via a new `VerifyOptions.ordinalsProvider`. A btco log fails verification without a provider; `OriginalsCel.verify` auto-threads the configured BitcoinManager's provider.

**BREAKING — CEL create-key binding:** for create proofs signed with a `did:key`, the key must be embedded in a self-certifying `data.did` (did:key / long-form did:peer:4). `PeerCelManager` now embeds the signer's key (via did:key config or a probe signature) plus a per-asset random key in generated did:peer DIDs. Logs created by older versions with a random-key did:peer and a did:key signer no longer verify.

**BREAKING — proofPurpose enforcement:** `Verifier.verifyCredential` requires `assertionMethod`, `verifyPresentation` requires `authentication`, and the verification method must be authorized under the corresponding relationship when the DID document resolves. The legacy CredentialManager path enforces the same purpose check.

**BREAKING — did:webvh is Ed25519-only:** non-Ed25519 `verificationMethods`/`updateKeys` are rejected at create/update time (resolution verifies DID logs with Ed25519, so such DIDs would be unresolvable).

**BREAKING — batch inscription:** `batchInscribeOnBitcoin({ singleTransaction: true })` now throws `BATCH_SINGLE_TX_UNSUPPORTED`: batched assets would share one inscription/satoshi and therefore one did:btco identity. Each asset is inscribed in its own transaction.

**BREAKING — non-segwit funding UTXOs rejected:** commit-transaction building, `selectUtxos`, and `PSBTBuilder` exclude/reject legacy (P2PKH/P2SH) funding UTXOs (fee estimation assumes ~68 vB witness inputs and signing supplies only witnessUtxo data). The per-input fee constant is unified at 68 vB (utxo.ts previously used 148 vB).

**BREAKING — `ResourceManager.createResource`** throws when an explicit `id` already exists instead of silently discarding that id's version history.

Other fixes: `did:btco` resolution uses the network encoded in the DID string; `migrateToDIDWebVH` emits an internally consistent document (VM ids/controllers and relationship refs rewritten, ports percent-encoded); btco `getCurrentState` works without a BitcoinManager (reads are pure log replay); `WebVHCelManager` migration detection keys off `sourceDid`; CEL CLI migrate/transfer derive network-scoped `did:btco:` identifiers from the signed migration data; `WebvhToBtcoMigration` errors clearly when the provider omits the satoshi instead of fabricating one from the txid; `MemoryStorageAdapter` composite keys are collision-free; `MetricsCollector` Prometheus export disambiguates sanitized-name collisions; `EventLogger` actually subscribes to the `migration:*`/`batch:progress` events its default config advertises; BBS+ derived-proof verification fails closed on disclosed-field/index count mismatch. didwebvh-ts ≤2.7.5 log compatibility is documented in docs/WEBVH_LOG_COMPATIBILITY.md.
