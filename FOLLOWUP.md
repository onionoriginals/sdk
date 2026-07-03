# Follow-up items

Correctness issues surfaced during the correctness loop that were deliberately
**not** fixed in this pass — either because they are latent (no observable
behavior today), require a product/design decision, or would exceed the
"minimal, targeted fix" scope. Each should be triaged separately.

## 1. `did:btco` resolution ignores the network encoded in the DID (latent)

- **Where:** `packages/sdk/src/did/DIDManager.ts` (`resolveDID`, the `did:btco:` branch).
- **What:** The `OrdinalsClient` is constructed with `this.config.network` rather
  than the network parsed from the DID string (`sig`/`reg`/`test`/mainnet).
- **Why deferred:** `OrdinalsClient` never reads its `network` field for
  resolution (sat/inscription lookups go to `rpcUrl` regardless), and
  `BtcoDidResolver` already derives the expected DID/network from the DID string
  itself. So there is **no observable behavior difference** today — this is a
  latent-correctness/consistency issue. It would become a real bug if
  `OrdinalsClient` started using `network` for endpoint routing. A fix here
  can't be covered by a meaningful regression test until then, so it's deferred
  rather than shipped untested.

## 2. `migrateToDIDWebVH` leaves verification-method ids/controllers on the old `did:peer` (design)

- **Where:** `packages/sdk/src/did/DIDManager.ts:141-144` (`migrateToDIDWebVH`).
- **What:** Only the document `id` is rewritten to the new `did:webvh:...`;
  `verificationMethod[].id`, `verificationMethod[].controller`, and the
  `authentication`/`assertionMethod` references still read `did:peer:<suffix>#0`.
  The produced document is internally inconsistent (VM controller ≠ subject),
  and a dev domain with a port is embedded unencoded (`localhost:8080` becomes a
  path segment) whereas the rest of the SDK percent-encodes ports.
- **Why deferred:** The current unit test (`tests/unit/did/DIDManager.test.ts`)
  asserts only that `publicKeyMultibase`/`service` are preserved and the slug is
  stable — it does not assert VM-id rewriting, so changing this alters the
  documented/tested contract of that path. Whether this path is meant to emit a
  fully resolvable webvh document (vs. a thin transitional wrapper) is a design
  decision. If it should be resolvable, VM `id`/`controller` and the
  relationship references must be rewritten to the new DID and the port
  percent-encoded.

## 3. `did:btco` anchoring is never cryptographically verified (design / threat-model)

- **Where:** `packages/sdk/src/cel/layers/BtcoCelManager.ts` (`getCurrentState`,
  witness-proof derivation) and `packages/sdk/src/cel/verifyEventLog.ts`.
- **What:** The resolvable `did:btco:<satoshi>` identity is taken from the
  `bitcoin-ordinals-2024` witness proof's `satoshi`. That proof is intentionally
  excluded from the controller signature and the hash chain, and
  `verifyEventLog` treats witness proofs as non-gating. So editing the witness
  proof's `satoshi`/`txid`/`inscriptionId` still yields `verified: true` while
  changing which sat the asset resolves to.
- **Why deferred:** Witness proofs are documented as non-gating trust additions,
  so this may be an accepted limitation. Making btco anchoring trustworthy needs
  an ordinals-provider check that (a) the inscription exists and is carried by
  the claimed `satoshi`, and (b) its content commits to the event's
  `digestMultibase`. That's a new verification dependency and a threat-model
  decision, not a minimal fix.

## 4. Fee estimators assume segwit (P2WPKH) inputs; legacy inputs under-estimated (bug, scoped-out)

- **Where:** `packages/sdk/src/bitcoin/transactions/commit.ts:129`
  (`estimateCommitTxSize`), `utxo-selection.ts:35`, `PSBTBuilder.ts:26` — all use
  ~68 vB/input, while `utxo.ts:31` uses 148 vB (legacy). Related:
  `commit.ts:477-484` adds every selected UTXO with only `witnessUtxo`.
- **What:** A legacy P2PKH input (~148 vB) is fee-under-estimated (tx can pay
  below the requested sat/vB and stall), and `@scure/btc-signer` needs
  `nonWitnessUtxo` for legacy inputs, so a non-segwit funding UTXO cannot be
  validly signed. The 68-vs-148 constant is also inconsistent across the four
  estimators.
- **Why deferred:** The proper fix is to derive per-input size and
  witness/non-witness data from each input's `scriptPubKey` (or explicitly
  reject non-segwit funding UTXOs with a clear error) and unify the per-input
  constant — a broader change to the transaction-building path that warrants its
  own PR and dedicated tests across input types.

## Iteration 2 deferrals

## 6. `encodeBase64UrlMultibase` uses multibase prefix `z` for base64url payloads (spec/interop — breaking to change)

- **Where:** `packages/sdk/src/utils/encoding.ts` (`encodeBase64UrlMultibase` / `decodeBase64UrlMultibase`), consumed by `CredentialManager` legacy proofs and `AuditLogger`'s keyless fallback.
- **What:** The helper emits `z` + base64url, but per multibase `z` is base58btc and `u` is base64url (the same file's `multibase` object correctly uses `u`). It round-trips internally, but a spec-compliant external verifier would decode a `z…` proofValue as base58btc and get garbage; the keyless audit fallback is also indistinguishable by prefix from a real base58btc Ed25519 signature.
- **Why deferred:** Correcting the prefix to `u` is a **wire-format change** — it would break verification of already-issued credentials and already-persisted audit records that carry the current `z`-prefixed base64url values. This needs a migration/compatibility plan (accept both prefixes during a transition, version the format) and coordination, not a silent in-place fix. No internal test currently fails because the SDK is symmetric with itself.

## 7. `ResourceManager.createResource` with a reused explicit `id` discards version history (medium — API-behavior decision)

- **Where:** `packages/sdk/src/resources/ResourceManager.ts` (`createResource`, the `this.resources.set(id, [resource])` line).
- **What:** Passing `options.id` for an id that already has multiple versions replaces the whole history with a single v1, silently. `importResource` merges instead, suggesting this is an oversight.
- **Why deferred:** The fix (throw, or return the existing current version) changes the public behavior of a method with ~47 call sites in the test suite, some of which may rely on overwrite semantics. Whether `createResource` on an existing id should throw, overwrite, or no-op is an API-design decision for the maintainers.

## 8. `MemoryStorageAdapter` composite key can collide across domain/path (latent, low)

- **Where:** `packages/sdk/src/storage/MemoryStorageAdapter.ts` (key = `` `${domain}::${cleanPath}` ``).
- **What:** `::` is unescaped, so `key('a::b','c') === key('a','b::c')`. did:webvh domains with ports/colon-escapes raise the odds slightly. One entry could overwrite another.
- **Why deferred:** Low severity and not currently triggered by any real caller; a clean fix (nested map or an unambiguous delimiter/encoding) is a small refactor best batched with the LocalStorageAdapter domain handling.

## 9. `MetricsCollector` Prometheus export can merge metric families on name sanitization collisions (latent, low)

- **Where:** `packages/sdk/src/utils/MetricsCollector.ts` (`safeOpName = operation.replace(/[^a-zA-Z0-9_]/g, '_')` used in metric *names*).
- **What:** Two operation names differing only in non-alphanumerics (`did.create` vs `did:create`) collapse to the same metric family, producing duplicate `# HELP`/`# TYPE` lines (a Prometheus parse error). In-repo callers use consistent dotted names, so latent.
- **Why deferred:** Not triggered by current callers; the fix (label-only form, or collision guard) is a small metrics-format change worth doing alongside a metrics review.

## 10. `EventLogger` default config advertises levels for events it never subscribes to (informational)

- **Where:** `packages/sdk/src/utils/EventLogger.ts` (`DEFAULT_EVENT_CONFIG` lists `migration:*` and `batch:progress`, but `subscribeToEvents`/`logEvent` handle neither).
- **What:** Those configured levels are dead code; migration/batch-progress events are not logged via EventLogger (they're handled in MigrationManager). Likely intentional, but the config table is misleading.
- **Why deferred:** Not a correctness bug; needs a maintainer decision to either trim the config or add the missing subscriptions.

## 11. Derived-proof message indexing in the (unimplemented) BBS+ path (latent)

- **Where:** `packages/sdk/src/vc/cryptosuites/bbsCryptosuite.ts:317-361`.
- **What:** The derived-proof verify reconstructs `disclosedMessages` in
  disclosed-document order but indexes them with original-credential indexes.
- **Why deferred:** The underlying `BbsSimple` primitives are unimplemented stubs
  that throw, and `DataIntegrityProofManager` only dispatches `eddsa-rdfc-2022`,
  so `bbs-2023` is never reachable. This would be a real correctness bug only
  once BBS+ is actually wired up; flagged for that work.

## 11. did:webvh logs created under didwebvh-ts ≤2.7.5 will not verify under 2.8.0 (data compatibility)

- **Where:** any persisted/published `did.jsonl` produced by SDK versions that
  pinned `didwebvh-ts` ≤2.7.5 (updateKeys were written as `did:key:z6Mk...`).
- **What:** didwebvh-ts 2.8.0's `isKeyAuthorized` requires `updateKeys` entries
  to be bare multikeys (`z6Mk...`, per the did:webvh spec) and compares them to
  the multikey parsed from each proof's `did:key:` verification method. Old logs
  store the prefixed form *inside signed log entries*, so resolution of those
  logs now fails with "Key did:key:... is not authorized to update." The entries
  are signed; they cannot be rewritten without breaking the hash/proof chain.
- **Why deferred:** this is a data-migration/product decision, not an SDK code
  fix: options include re-creating affected DIDs, or upstream didwebvh-ts
  accepting the legacy prefixed form during verification for backward
  compatibility. New logs created by the SDK now use the spec format.

## Iteration (branch n08sq0) deferrals

## 12. `did:webvh` resolution is hardcoded to `Ed25519Verifier` — non-Ed25519 did:webvh DIDs are unresolvable (design)

- **Where:** `packages/sdk/src/did/DIDManager.ts` (`resolveDID`, the `did:webvh`
  branch passes `{ verifier: new Ed25519Verifier() }`).
- **What:** The did:webvh create path accepts arbitrary `externalSigner` /
  `verificationMethods` / `updateKeys` (Turnkey, AWS KMS, HSM) with no key-type
  enforcement (`WebVHManager.ts:336-360`), but resolution only wires an
  Ed25519 verifier. A did:webvh published with a secp256k1/P-256 external signer
  verifies with its external verifier yet `resolveDID` returns `null` — the DID
  appears not to exist.
- **Why deferred:** This is a design decision about whether did:webvh is
  Ed25519-only (the SDK's internal signing path is) or must support multiple
  algorithms. The correct fix is either (a) reject non-Ed25519
  `verificationMethods`/`updateKeys` up front in the create/update paths, or
  (b) dispatch a verifier by the log key's multicodec at resolution time — a new
  multi-algorithm verifier component. Both change the documented capability
  surface and warrant a dedicated decision + tests rather than a minimal fix.

## 13. CEL create-event controller key is not bound to a self-certifying `data.did` (threat-model / TOFU)

- **Where:** `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (authorized-key
  seeding from the create event's controller proof; no comparison against
  `createEvent.data.did`).
- **What:** For `did:peer` (numalgo-4) and `did:key`, the identifier embeds the
  controller's public key, so the create key ↔ DID binding is checkable offline.
  `verifyEventLog` never checks it, so an attacker can copy a victim's create
  event `data` verbatim, re-sign event 0 with their own key as the single
  controller proof, append attacker-signed events, and the log verifies — a
  "valid" provenance log for the victim's DID actually controlled by the
  attacker's key.
- **Why deferred:** The code's stated model is explicit trust-on-first-use (the
  create event is the root of authority; external identity binding is the
  resolver's job — comment at verifyEventLog.ts ~506-522). Whether to add a
  self-certifying `create-key == key-in-data.did` check for peer/key DIDs is a
  threat-model decision, distinct from FOLLOWUP #3 (btco witness anchoring).

## 14. `batchInscribeOnBitcoin({ singleTransaction: true })` collapses N assets onto one Bitcoin identity + no per-item atomicity (design / API)

- **Where:** `packages/sdk/src/lifecycle/BatchLifecycleOperations.ts` (the
  `singleTransaction` path: one `inscribeData` call, then a migrate loop that
  sets every asset's `did:btco` binding to `did:btco:<sameSat>`).
- **What:** All assets in a single-transaction batch receive the same
  `inscriptionId`/`satoshi` and therefore the same `did:btco:<sat>` identity.
  Since a did:btco identity is satoshi-scoped, the batched assets share one
  on-chain identity; worse, `transferOwnership` reads `latestMigration.satoshi`,
  so transferring one asset moves the UTXO the others also claim. The path also
  hand-rolls its migrate loop without `BatchOperationExecutor` isolation: a
  mid-loop `migrate()` throw (e.g. a mixed batch with an already-btco asset)
  leaves the inscription broadcast and some assets mutated while the thrown
  `BatchError` reports `successful: 0`.
- **Why deferred:** Single-transaction batching is an intentional cost-saving
  mode; whether it should assign distinct sub-identities (e.g. per-index
  inscription offsets) or be documented as identity-sharing — and how partial
  failure after broadcast should be reported — are product/design decisions that
  change batch semantics and the public result shape, not a minimal fix.

## 15. CEL CLI `migrate`/`transfer` display helpers emit a network-less `did:btco:<sat>` (minor, latent)

- **Where:** `packages/sdk/src/cel/cli/migrate.ts` (`resolveMigrationDid`) and
  `packages/sdk/src/cel/cli/transfer.ts` derive `did:btco:${satoshi}` for
  human-readable output.
- **What:** Companion to the programmatic fix in `BtcoCelManager.getCurrentState`
  (now network-scoped via the inscribing `BitcoinManager`). The CLI helpers are
  pure functions over an event log, and the btco migration event does not carry
  the Bitcoin network in its signed data, so they cannot derive the correct
  `sig`/`reg` prefix without the CLI being told the configured network via a
  flag/config.
- **Why deferred:** These are display-only paths (the resolvable identity comes
  from `getCurrentState`, which is fixed). A correct fix needs a network source
  threaded into the inspect/migrate/transfer CLI commands — a small CLI-plumbing
  change best batched with a CLI network-config pass, and not coverable by a
  meaningful regression test until that config exists.
