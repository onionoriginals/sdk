# @originals/sdk

## 3.0.0

### Major Changes

- 18fb3bf: **Security:** BBS+ selective disclosure now fails closed. Both no-key paths threw away the caller's privacy intent while reporting success.

  `deriveSelectiveProof` fell back, for any credential without a `bbs-2023` proof, to returning the credential **unchanged** while listing the undisclosed paths in `hiddenFields`. A caller who trusted that report and forwarded `result.credential` published every field it claimed to withhold. It now throws `BBS_BASE_PROOF_REQUIRED`.

  `prepareSelectiveDisclosure` had the matching hole: given no key pair it returned a "metadata-only" result — the credential untouched, pointer arrays attached — which read as success but created no proof, so nothing could ever be derived from it. It now throws `BBS_KEY_REQUIRED`.

  These combined into one trap: the example in `docs/LLM_AGENT_GUIDE.md` passed no key, so it demonstrated the metadata-only path, and a reader following it got a credential with no proof and then a "derived" result that redacted nothing. The example is corrected to show the real flow.

  **Breaking:** calls that previously resolved now throw. Any code relying on either fallback was not performing selective disclosure — it was either producing an unusable credential or leaking. Pass a BBS+ key pair to `prepareSelectiveDisclosure` and derive from its output.

  Note the SDK still cannot generate BLS12-381 keys (`KeyManager` covers ES256K / Ed25519 / ES256), so issuers must bring their own via `@digitalbazaar/bbs-signatures`; `multikey.encodePublicKey(publicKey, 'Bls12381G2')` encodes it for the DID document. The documented example shows this.

## 2.1.0

### Minor Changes

- 99dfa90: Make the SDK importable in browsers and edge runtimes, and add a slim genesis-only entry point.

  **`@originals/sdk` no longer pulls Node builtins at import time.** Previously the package entry point statically reached `fs`, `path`, `fs/promises`, a bare `crypto`, and `node:zlib`, so it failed to load outside Node regardless of which features you used.

  - Status-list GZIP moves from `node:zlib` to `fflate`. `BitstringStatusList.encode()`/`decode()` and `StatusListManager.encodeBitstring`/`decodeBitstring` stay **synchronous** — a lazy `await import('node:zlib')` would have forced those public methods async. The wire format is unchanged and verified round-trip against `node:zlib` in both directions, including the legacy ZLIB-wrapped DEFLATE encoding.
  - `utils/encoding` uses `@scure/base` instead of `Buffer` for base64/base64url/base58. Drops the `b58` dependency.
  - `LocalStorageAdapter` and `WebVHManager` load `fs`/`path` lazily on first use, matching `FileLogOutput`. Node-only behaviour is unchanged; the path-traversal guards keep Node's exact `path` semantics.
  - Selective disclosure uses the Web Crypto `crypto.randomUUID` global rather than importing `crypto`.

  **New `@originals/sdk/cel` entry point** for genesis-only (`did:cel`) consumers: 34 modules and 248 KB versus 116 modules and 1201 KB for the root barrel, dropping `bitcoinjs-lib`, `jsonld`, `@digitalbazaar/bbs-signatures`, `didwebvh-ts`, `@scure/btc-signer` and more. `@originals/sdk/cel/*` deep imports are exported too.

  **`LifecycleManager` no longer pulls the VC stack.** `CredentialManager` is injected, so it is now a type-only import; `OriginalsAsset` duck-types its credential check instead of `instanceof`. Importing `lifecycle/LifecycleManager` drops from 75 modules / 821 KB to 59 / 653 KB and no longer drags in `jsonld`.

  **Bug fix:** `OrdinalsLookup.content` is typed `Uint8Array`, but four call sites in `verifyEventLog` and `LifecycleManager` called `.toString('utf8')` on it — a `Buffer`-only overload. Any `OrdinalsProvider` returning a plain `Uint8Array` produced a comma-separated digit string and threw in `JSON.parse`. They now use `TextDecoder`.

  A new `scripts/check-browser-safety.mjs` CI gate fails the build if a guarded entry point regains a static Node-builtin import, and runs as a publish gate alongside the ESM check.

  Note: the Bitcoin modules (`bitcoin/transactions/commit`, `QuickNodeProvider`, `crypto/Signer`) still require `Buffer` at runtime, because `bitcoinjs-lib`'s API is Buffer-based. They are not reachable from the `cel` entry point.

## 2.0.0

Initial published release. Version 2.0.0 was tagged internally but never published to npm, so all changes accumulated during the pre-release stabilization effort ship as part of this initial 2.0.0 release rather than as a 2.0.0 → 3.0.0 increment. The consumed changesets are consolidated below.

### Breaking Changes

These are "breaking" relative to unpublished pre-release builds; no published version is affected.

- **Node ESM support; `engines.node` raised to `>=20.10.0`.** The built `dist` previously emitted extensionless relative imports and attribute-less JSON imports, which Node ESM rejects — the package could not be imported by npm consumers. All relative imports now carry explicit `.js`/`/index.js` extensions, JSON imports use `with { type: "json" }`, and the package compiles under `moduleResolution: "NodeNext"` so the compiler enforces correct ESM specifiers going forward. The raised runtime floor is required for JSON import attributes.
- **CBOR encoder replaced (#236).** `cbor-js` (which silently corrupted strings containing U+E000–U+FFFF and allowed `__proto__` prototype pollution on decode) is replaced by `cborg`. CBOR byte output for previously mis-encoded strings changes; decode now rejects malformed input instead of returning garbage.
- **Rollback honesty (#237).** `RollbackManager` reports `PARTIALLY_ROLLED_BACK` (success: false) with an `irreversibleArtifacts` list for Bitcoin-targeted migrations instead of unconditional success. New `MigrationStateEnum.PARTIALLY_ROLLED_BACK` terminal state; `MigrationResult.rollback` carries the rollback outcome.
- **`migrateToDIDWebVH` creates real DIDs (#245, #246).** peer→webvh migration now goes through didwebvh-ts `createDID`, producing a spec-valid `did:webvh:{SCID}:{domain}:{slug}` with a signed log (previously an unresolvable rename). New `migrateToDIDWebVHDetailed` returns the log/keyPair/logPath. `saveDIDLog` parses SCID-first DIDs and lays logs out to mirror the resolution URL.
- **`publishToWeb` requires storage (#244).** Throws `STORAGE_REQUIRED` when no adapter with `put`/`putObject` is configured instead of silently discarding content into a throwaway in-memory adapter.
- **`OrdinalsClient` fails loudly (#248).** `broadcastTransaction`/`getTransactionStatus`/`estimateFee` throw `NOT_IMPLEMENTED` structured errors instead of fabricating success values.
- **`transferInscription` returns only provider-attested data (#290).** `BitcoinManager.transferInscription` no longer mutates the caller's inscription object (`inscription.satoshi = …`) and no longer fabricates a `vin` from the caller's stale txid/vout or a dust-valued `vout` when the provider omits outputs. Unknown inputs/outputs are surfaced as empty arrays. Callers that read the fabricated `vout[0]` or relied on the input being mutated must adjust.
- **CEL `digestMultibase` is now a spec-conformant multihash (#258, emit side).** `computeDigestMultibase` prepends the sha2-256 multihash header (`0x12 0x20`), so newly written `previousEvent` chain links and external-reference digests are Multibase-encoded Multihashes interoperable with other CEL implementations. The read path is tolerant: `decodeDigestMultibase`, `verifyDigestMultibase`, and event-log/witness verification (via the new exported `digestMultibaseEquals`) accept both the multihash form and the legacy bare-digest form, because logs anchored on Bitcoin in the old format are immutable and cannot be recomputed. Mixed-format chains verify correctly; other CEL implementations will still reject the legacy-format links, so recompute/re-anchor where interop matters.
- **base64url multibase wire format.** `encodeBase64UrlMultibase`/`decodeBase64UrlMultibase` now emit and accept only the spec-correct `u` multibase prefix (previously `z`, which per multibase means base58btc). Legacy-path credential proofValues, MultiSig proofValues, and keyless audit-record integrity hashes produced by older pre-release builds no longer verify.
- **btco anchoring is now gating.** `verifyEventLog` verifies `bitcoin-ordinals-2024` witness proofs against the chain (inscription exists, sits on the claimed satoshi, content commits to the event digest) via a new `VerifyOptions.ordinalsProvider`. A btco log fails verification without a provider; `OriginalsCel.verify` auto-threads the configured BitcoinManager's provider.
- **CEL create-key binding.** For create proofs signed with a `did:key`, the key must be embedded in a self-certifying `data.did` (did:key / long-form did:peer:4). `PeerCelManager` now embeds the signer's key (via did:key config or a probe signature) plus a per-asset random key in generated did:peer DIDs. Logs created by older pre-release builds with a random-key did:peer and a did:key signer no longer verify.
- **proofPurpose enforcement.** `Verifier.verifyCredential` requires `assertionMethod`, `verifyPresentation` requires `authentication`, and the verification method must be authorized under the corresponding relationship when the DID document resolves. The legacy CredentialManager path enforces the same purpose check.
- **did:webvh is Ed25519-only.** Non-Ed25519 `verificationMethods`/`updateKeys` are rejected at create/update time (resolution verifies DID logs with Ed25519, so such DIDs would be unresolvable).
- **Batch inscription.** `batchInscribeOnBitcoin({ singleTransaction: true })` now throws `BATCH_SINGLE_TX_UNSUPPORTED`: batched assets would share one inscription/satoshi and therefore one did:btco identity. Each asset is inscribed in its own transaction.
- **Non-segwit funding UTXOs rejected.** Commit-transaction building, `selectUtxos`, and `PSBTBuilder` exclude/reject legacy (P2PKH/P2SH) funding UTXOs (fee estimation assumes ~68 vB witness inputs and signing supplies only witnessUtxo data). The per-input fee constant is unified at 68 vB (utxo.ts previously used 148 vB).
- **`ResourceManager.createResource`** throws when an explicit `id` already exists instead of silently discarding that id's version history.
- **didwebvh-ts 2.7.5 → 2.8.0 (stricter did:webvh key authorization).** `did.jsonl` logs persisted by builds against didwebvh-ts ≤2.7.5 store `did:key:`-prefixed updateKeys inside signed log entries and no longer verify/resolve under 2.8.0's stricter check; the entries are signed and cannot be rewritten, so affected DIDs must be re-created (see docs/WEBVH_LOG_COMPATIBILITY.md). Every did:webvh create/update/rotate/recover path now passes bare multikeys (`z6Mk...`) as `updateKeys` and computes pre-rotation `nextKeyHashes` over the bare key. A new exported `normalizeUpdateKey()` strips the legacy `did:key:` prefix (and fragment) from caller-provided `updateKeys` in `WebVHManager.createDIDWebVH`, `DIDManager.createDIDWebVH`, `OriginalsSDK.createDIDOriginal`, and `OriginalsSDK.updateDIDOriginal`, so existing external-signer integrations keep working. Combining legacy `did:key:`-form updateKeys with `nextKeyHashes` in the `OriginalsSDK` Original wrappers is rejected with a descriptive error; compute hashes with the newly exported `computeNextKeyHash(<bare multikey>)`. `createDIDOriginal` also forwards the previously-dropped `nextKeyHashes`, `portable`, `controller`, `alsoKnownAs`, `authentication`, `assertionMethod`, `keyAgreement`, and `services` options.

### Security

- **Verifiable Credential issuer/holder binding.** The Data Integrity verify path (`Verifier.verifyCredential` / `verifyPresentation`) resolved the signing key solely from `proof.verificationMethod` and never checked that its controlling DID matched the credential `issuer` (or presentation `holder`) — full issuer impersonation. Verification now binds the proof's verification method to the issuer/holder before checking the signature, failing closed when the issuer/holder is absent. The legacy verify path likewise rejects a signed credential with no issuer to bind the signing key to.
- **Signing-side issuer binding (#259).** `CredentialManager.signCredential` populates the verification method's `controller` from the resolved DID document instead of `credential.issuer`, so a key for one DID can no longer mint credentials claiming a foreign issuer; the refusal fails closed instead of falling through to legacy signing.
- **Revocation fails closed.** `CredentialManager.verifyCredentialWithStatus` returns `verified: false` when a credential declares a `BitstringStatusListEntry` that cannot be evaluated (no status list supplied, purpose mismatch, out-of-range index, corrupt list) instead of `verified: true` / `revoked: false`.
- **Status list credentials validated before use (#238).** Id binding, own proof, and issuer match are checked before their bits decide revocation — closes a revocation bypass. `StatusListManager.setStatus`/`batchSetStatus` strip any stale `proof` from the returned credential (the updated bitstring invalidates the old signature, forcing a re-sign) (#289).
- **Status list decompression capped at 16 MiB (#262).** `StatusListManager.decodeBitstring` / `BitstringStatusList.decode` reject gzip/DEFLATE bombs from attacker-suppliable status list credentials.
- **Multi-sig verification hardened.** Standard Data Integrity (`eddsa-rdfc-2022`) proofs on signing and DI-only verification in `MultiSigManager.verifyMultiSig` and `Verifier.verifyCredentialMultiSig` — the legacy digest proof format is gone (#239). Duplicate proofs from the same signer are rejected, closing a threshold bypass where one authorized key could satisfy any N-of-M policy. The multi-sig path now also enforces the credential validity window and fails closed on uncheckable revocable status, removing a revocation/expiry bypass relative to the single-sig path.
- **CEL event logs bound to the controller key.** Previously any key could append, rename, "migrate", or deactivate anyone's log and it verified as valid. `verifyEventLog` now establishes the authorized key set from the create event and rejects any subsequent event whose controller proof is signed by an unauthorized key. It also requires the first event to be a `create` event (#295) and treats `deactivate` as terminal (#257).
- **CEL witness proofs verified against the signed digest (#240).** Honest witness attestations now report `verified: true`.
- **`OrdHttpProvider` SSRF hardening (#265).** The indexer-supplied `content_url` is pinned to `baseUrl`'s origin, JSON and content fetches are size-capped, and redirects are refused (`redirect: 'error'`) so a same-origin URL cannot 30x to an internal host.
- **`LocalStorageAdapter` path traversal (#251).** Domains that resolve outside `baseDir` (e.g. `..`) are rejected.
- **Strict base64url validation (#250).** `decodeBase64UrlMultibase` validates the base64url alphabet strictly (proofValue malleability).
- **Document loader registry fallback restricted (#260).** The verification-method registry fallback for resolved DID documents is limited to self-certifying methods (did:key/did:peer); keys removed from a hosted did:webvh or on-chain did:btco document can no longer be resurrected from the process-global registry.
- **`base64.decode` memory disclosure.** Now returns the decoded bytes instead of wrapping the Buffer pool's backing ArrayBuffer, which returned ~8KB of unrelated memory on Node and corrupted base64url/multibase/CEL digest decoding.
- **Ordinal-safe UTXO selection across all selectors (#249).** `selectUtxos`/`buildTransferTransaction`, `selectUtxosSimple`, `selectResourceUtxos`/`selectUtxosForPayment`, and `PSBTBuilder` exclude inscription-bearing (`inscriptions[]`), `hasResource`-flagged, and locked UTXOs by default, so an ordinal-carrying UTXO can no longer be spent as a plain fee/payment input and burned. Opt in via `allowOrdinalUtxos` / `forbidInscriptionBearingInputs: false`.
- **Concurrency and double-pay guards (#255, #243).** Concurrent migrate/inscribe/publish of the same asset or DID is rejected; batch validation flags duplicate assets.
- **Repo hygiene (#294).** A committed TLS private key was removed and `*.pem`/`*.key` are ignored; dead Railway/Nixpacks deploy config and the orphaned `server/`/`shared/` directories (undeclared deps + a plaintext key store) were deleted (#284, #285).

### Fixed

- **did:webvh resolution.** `DIDManager.resolveDID` called didwebvh-ts with no verifier, so every valid `did:webvh` resolved to `null` (breaking credential verification, lifecycle, the document loader, and CEL key resolution for webvh issuers). It now passes the SDK's `Ed25519Verifier`.
- **CEL did:btco migrations produce verifiable logs.** `BtcoCelManager.migrate` mutated the event `data` after the controller signature and Bitcoin witness proof were computed, so every btco log failed `verifyEventLog`. Migration data is now finalized before signing: `targetDid` is derived deterministically from the source DID, and `txid`/`inscriptionId` are read from the Bitcoin witness proof. The `originals-cel migrate` CLI warns that a temporary (non-controller) signing key produces a log that won't verify under controller binding.
- **CEL did:btco layer/DID detection.** Detectors keyed off `targetDid`, mis-detecting a `peer → webvh → btco` log as still at `webvh` — `getCurrentState` returned the old webvh DID, the terminal-layer guard was bypassed (allowing a second inscription), and the CLI recorded the wrong `previousOwner` on transfers. All detectors (including `WebVHCelManager`) now key off `sourceDid` and derive `did:btco:<satoshi>` from the witness proof. btco `getCurrentState` works without a BitcoinManager (reads are pure log replay) and derives network-scoped identifiers (`did:btco:reg:`/`did:btco:sig:`) from the inscribing `BitcoinManager`; the CEL CLI migrate/transfer derive network-scoped identifiers from the signed migration data.
- **Canonical `did:btco` identifiers.** A new `canonicalizeSatoshi()` is used when building the DID in `createBtcoDidDocument` and the `DIDManager` keyless-fallback path, so `' 42 '`/`'007'` no longer produce unresolvable or non-canonical DIDs. did:btco resolution uses the network encoded in the DID string, and explicit `config.network` takes precedence over the webvhNetwork mapping (#247); lifecycle bindings are network-prefixed.
- **did:btco tombstone detection.** A valid DID document that merely contains the 🔥 codepoint no longer deactivates the DID — only the human-readable marker line does (#269); the marker regex is digit-bounded so `did:btco:128` no longer prefix-matches a `did:btco:1280` inscription. Deactivated (🔥 tombstoned) DIDs no longer resolve to the pre-deactivation document; resolution returns `didDocument: null` with `didDocumentMetadata.deactivated: true`.
- **did:btco resolution provider routing (#266).** `DIDManager.resolveDID` routes did:btco resolution through the configured `ordinalsProvider` (via the new `OrdinalsProviderResolverAdapter`); with neither a provider nor an explicit `bitcoinRpcUrl`, it throws a structured `ORD_PROVIDER_REQUIRED` error instead of silently querying `http://localhost:3000`.
- **`inscribeData` satoshi handling (#256).** Throws `ORD_SATOSHI_UNKNOWN` (carrying inscription details) instead of returning an empty satoshi; callers no longer fabricate did:btco identifiers from txids. `BitcoinWitness.witness()` recovers the satoshi via `getSatoshiFromInscription` before failing closed, so providers that don't return a satoshi from `createInscription` (e.g. `OrdHttpProvider`) no longer break btco witnessing; `WebvhToBtcoMigration` errors clearly when the provider omits the satoshi instead of fabricating one from the txid.
- **Lifecycle transfer correctness.** `transferOwnership` resolves the real inscription on the satoshi via the provider (new `BitcoinManager.getInscriptionIdBySatoshi`) and throws `INSCRIPTION_NOT_FOUND` rather than fabricating an `insc-<sat>`/`unknown-tx` inscription into provenance (#273); satoshi extraction is network-aware via `parseSatoshiIdentifier` (a regtest/signet transfer no longer looks up the network tag as the satoshi).
- **Fee handling.** `selectUtxos` funds a changeless transaction instead of throwing `INSUFFICIENT_FUNDS` when the accumulated amount covers a single-output spend but not a two-output one (#290). Fee rates returned by a fee oracle or ordinals provider are subject to the same upper bound as caller-supplied rates (an absurd estimate is skipped); `BitcoinValidator` consults the fee oracle/provider and corrects its network warning.
- **Credential validation and legacy-path fixes.** `validateCredential` accepts W3C VC 2.0 credentials (`https://www.w3.org/ns/credentials/v2` context, `validFrom`) so the SDK's own issued credentials no longer fail deserialization (#264). The legacy verify path enforces the validity window (an expired legacy-signed credential no longer verifies). Legacy credential and multi-sig proof signing/verification select the signature algorithm from the key's multicodec type via the new `signerForKeyType` helper instead of `config.defaultKeyType` (#261). `Verifier.verifyCredential` no longer stringifies an inline-object `@context` into `"[object Object]"` (#289). BBS+: `BBSCryptosuiteUtils.parseBaseProofValue` rejects the derived-proof header `0x03` (#289), and derived-proof verification fails closed on disclosed-field/index count mismatch.
- **Crypto correctness.** Signing with a 64-byte Ed25519 secret key (`seed || publicKey`) used the seed instead of slicing it off, so signatures verify again. Private-key multicodec headers for secp256k1, P256, and BLS12-381 G2 match the multicodec registry varints (legacy SDK-encoded secp256k1 private keys still decode). `multikey.decodeMultibase` accepts `u` (base64url) in addition to `z` (base58btc); unknown prefixes still fail closed. `hexToBytes` rejects any non-hex character instead of silently truncating. A new `parseStatusListIndex()` fails closed on non-integer `statusListIndex` input in `checkStatus`/`revoke`/`suspend`/`unsuspend`.
- **did:webvh document consistency.** `migrateToDIDWebVH` emits an internally consistent document (VM ids/controllers and relationship refs rewritten), preserves each source-peer key's `keyAgreement`/`capabilityInvocation`/`capabilityDelegation` relationship (#299), and percent-encodes a domain port (`did:webvh:localhost%3A8080:slug`) so the DID stays a single authority segment and resolves.
- **Migration/batch fixes (#293).** Fail-fast batch operations throw a `BatchError` carrying partial results; resource-version numbering honors declared versions and `ResourceManager.getResourceVersion` matches by stored version number instead of array position; the dead asset-level `asset:created` emit is removed; `getActiveMigrations` returns all non-terminal states (incl. `ANCHORING`); failed-migration audit records the real validation results; `migrateBatch` guards empty input, dedupes DIDs, and honors `maxConcurrent`; `migrate({ estimateCostOnly: true })` returns an estimate without executing a paid migration (#254).
- **Config and infra.** The `OriginalsSDK` constructor honors `config.keyStore` (#277). `OriginalsSDK.create` derives the webvhNetwork tier from an explicit Bitcoin `network` (regtest→magby, signet→cleffa, mainnet→pichu) instead of silently targeting the production `pichu` domain (#294). `FileLogOutput` uses `node:fs/promises` `appendFile`, so file logging works under Node (previously every flush threw `ReferenceError: Bun is not defined`, swallowed internally) and appends instead of rewriting the whole log. `MemoryStorageAdapter` composite keys are collision-free; `MetricsCollector` Prometheus export disambiguates sanitized-name collisions; `EventLogger` subscribes to the `migration:*`/`batch:progress` events its default config advertises. npm publish works (`--provenance` moved to `NPM_CONFIG_PROVENANCE`) and the test setup preload applies in CI and per-package runs (#252, #253).

### Added

- **Opt-in did:webvh pre-rotation key support.** `createDIDWebVH`/`rotateDIDWebVHKeys` `prerotation` option with a returned `nextKeyPair`, plus guards that reject misuse on pre-rotation chains. Exported `normalizeUpdateKey()` and `computeNextKeyHash()` helpers.
- `migrateToDIDWebVHDetailed`, `BitcoinManager.getInscriptionIdBySatoshi`, `OrdinalsProviderResolverAdapter`, `canonicalizeSatoshi()`, `parseStatusListIndex()`, `signerForKeyType`, and `digestMultibaseEquals` (exported).

### Dependencies & Publishing

- **didwebvh-ts 2.7.5 → 2.8.0** (see Breaking Changes).
- **noble-crypto group:** `@noble/curves` 1.6→2.2 (subpath exports gain explicit `.js` extensions and were reorganized; BLS12-381/BBS+ uses the `shortSignatures` namespace and `Point.toBytes()`), `@noble/ed25519` 2→3.1 and `@noble/secp256k1` 2→3.1 (`utils.randomPrivateKey()` → `utils.randomSecretKey()`, hash configuration moved to the writable `hashes` object in `noble-init.ts`), `@scure/base` 1.1→2.2, `@scure/btc-signer` 1.8→2.2 (`Address(...).decode()` may return `undefined`; `scriptPubKeyForAddress` guards it). No public API changes.
- **uuid 13.0.2 → 14.0.1** (only the unchanged `v4` export is used).
- **Publishing:** `README.md` and `LICENSE` (MIT) ship in the npm tarball; the exports map gains a `"default"` condition alongside `"import"` for tooling that does not match the `import` condition (e.g. `require(esm)` consumers); `"./package.json"` is exported.

### Change detail (consolidated changesets)

Per-changeset notes for everything folded into this release. The sections above summarize the pre-release stabilization effort; the notes below carry the full detail, including the did:cel / CEL-convergence work that landed after that summary was written.

#### Breaking

- db8beba: Implement the BBS+ selective-disclosure cryptosuite (`bbs-2023`), replacing the `BbsSimple` stub. `BBSCryptosuiteManager` now signs, verifies, and derives selective-disclosure proofs over real BLS12-381 keys via `@digitalbazaar/bbs-signatures`, with the W3C Data Integrity selective-disclosure pipeline (skolemization, HMAC-shuffled label maps, JSON-Pointer selection) in `vc/utils/selective-disclosure.ts`. Verification keys always resolve from the DID document via the document loader (fail-closed), never from the attacker-controlled proof.

  BREAKING: the `BbsSimple` class and its root export (`export { BbsSimple } from '@originals/sdk'`) are removed. It was a non-functional stub that threw from every method; consumers should use `BBSCryptosuiteManager` instead.

- e845cb7: Remove `did:peer` entirely as a creation path and genesis layer (did:cel epic, Phase 4 · 5/5). `did:cel` is now the sole genesis layer.

  - **Removed:** `DIDManager.createDIDPeer` (all overloads) and the private `getLayerFromDID` helper. There is no supported API to create a `did:peer` identifier.
  - **Breaking (`LayerType`):** `'did:peer'` is removed from `LayerType` (`'did:cel' | 'did:webvh' | 'did:btco'`). `OriginalsAsset.determineCurrentLayer` now throws on a `did:peer:` id (a genesis asset is always `did:cel`), and `validTransitions` no longer keys `'did:peer'`.
  - **Migration:** `DIDManager.migrateToDIDWebVH` derives the did:webvh slug from the last source-DID segment generically; the numalgo-4 `did:peer` long-form slug branch is gone. `did:cel → did:webvh → did:btco` is unaffected.
  - **Kept (legacy read path, unchanged behavior):** `verifyEventLog` still accepts long-form `did:peer:4` self-certification, the CEL-layer resolution branches still read legacy `did:peer` logs, and `documentLoader` still treats `did:peer` as self-certifying so **existing** did:peer credentials keep verifying. Only creation and the genesis layer are removed — verification of legacy artifacts stays.

#### Features

- 6ef2c47: Bind btco asset identity to the controller-**signed** anchoring satoshi. The migrate-to-btco CEL event now signs `data.to = did:btco:<network>:<sat>` (upgraded from a bare `'did:btco'`), and `verifyEventLog` derives the anchored sat from that signed body instead of the unsigned Bitcoin witness proof array. This closes two keyless-verifier soundness residuals: the **cross-sat fork** (repointing the witness to an attacker-controlled sat) and **witness-stripping** (dropping the witness so the log reads as never-anchored).

  - **Breaking (verifier behavior):** a btco-anchored log whose migrate event does not sign a parseable sat now fails with `UNBOUND_ANCHOR`. A Bitcoin witness proof whose satoshi disagrees with the signed `data.to` is rejected. A signed btco migrate with no verifiable witness on the signed sat fails closed. This is a **hard cutover** — logs built with the old bare-`did:btco` migrate shape must be regenerated (nothing is released; only test logs existed).
  - **Removed:** the ">1 witness poisons the anchor" ambiguity rule and the `STALE_LOG`-for-poisoned-anchor path — the signed `to` now disambiguates the canonical sat, so extra witnesses on other sats are simply invalid.
  - Provenance fold (`replayProvenance`) and envelope restore now read the btco binding from the signed `data.to`, not the witness satoshi.

  Unchanged: `did:cel` derivation, forward resolution, and the ownership-is-the-sat model (ownership is live sat control via `getCurrentOwner`). The `did:cel` uniqueness / first-anchor-wins work and the DID-document `alsoKnownAs` `did:cel` back-link are a separate follow-up spec, not included here.

  Known follow-up (#397): the secondary `BtcoCelManager.migrate` / `cel migrate` btco path does not yet sign the anchoring sat and currently produces logs that fail `UNBOUND_ANCHOR`; it must land before a release is cut. The production `LifecycleManager.inscribeOnBitcoin` path is fully updated.

- d5ebec2: Batch of independent review fixes (#302, #304, #305, #306, #310, #314, #329):

  - **#310 (breaking for multi-sig external signers):** multi-sig external-signer contributions were unverifiable — the signer canonicalized itself (JCS) while verification hashes RDFC-2022. The SDK now canonicalizes+hashes and the signer signs those exact bytes via a new optional `ExternalSigner.signBytes(data)`; a signer implementing only the document-level `sign()` is refused up front. did:webvh signing and all other `sign()` usage are unaffected.
  - **#306:** multi-sig signing rejects non-Ed25519 signer keys with a clear upfront error, and verification reports a distinguishing "unsupported/legacy proof format" message instead of a generic "Invalid signature".
  - **#305:** multi-sig proofs are verified concurrently over one shared document loader (deterministic post-collection dedupe; results unchanged).
  - **#304:** the status list credential's proof verification is memoized on the full resolved document (positives-only, TTL-bounded), avoiding N re-verifications of one shared list.
  - **#302:** rollback reports `PARTIALLY_ROLLED_BACK` whenever the failure error carries on-chain artifacts, regardless of the tracked pre-anchoring state.
  - **#314:** added the exported `witnessSigningBytes(digest)` helper and documented the CEL witness signing-byte contract.
  - **#329:** `listObjects(domain, prefix)` is now an optional, documented member of the public `StorageAdapter` interface (additive).

- 37e8730: Content-addressed separation (epic #407 phase 1): resource-update CEL events now reference content by a signed `toHash` instead of embedding the file bytes. **Breaking to the on-log event shape** — a resource-update `update` event's `data` is now `{ resourceId, contentType, previousVersionHash, toHash, toVersion }` with no `content` field, reversing #401's embed-the-bytes shape.

  Content travels as content-addressed blobs alongside a byte-light log: the `serialize()` envelope carries the bytes in its `resources` array (keyed by hash), so offline verification is preserved — `loadAsset` binds `hash(blob) == toHash` (and every envelope resource must match a log-declared hash by resourceId, or it fails closed). The verifier checks only hash-chain continuity on the signed hashes and no longer recomputes `hash(content)` from the event. This shrinks the log so it can be affordably inscribed on Bitcoin in a later phase (#407). Public APIs (`addResourceVersion`, `serialize`, `loadAsset`) are unchanged externally.

- 0e6674a: Fee preview + confirm for did:btco appends (#407 phase 4). Once an asset reaches
  did:btco (the final layer) every authorship append is a mandatory, paid Bitcoin
  inscription with no hosted fallback — phase 4 makes that cost visible up front and
  consented to.

  - `LifecycleManager.estimateAppendCost(asset, appendKind, opts?)` — a non-mutating
    quote for the NEXT btco append, returning `{ satoshis, feeRate, vbytes,
contentBytes }`. It sizes the actual payload (`opts.content` / the in-flight new
    media for `'update'`, the reinscribed DID doc for `'rotate'`) and reuses the same
    fee-rate source and `MAX_REASONABLE_FEE_RATE` cap as the real inscribe path, so
    the quote tracks reality. Zero side effects — no signing, appending, or
    inscription. Throws `ORD_PROVIDER_REQUIRED` without an ordinalsProvider.
  - `inscribeConfirm` gate — a per-call option on `addResourceVersion` and
    `rotateBtcoKeys`, plus a config default on `OriginalsConfig`. `'now'` (default)
    is the phase-3 behavior (inscribe immediately). A callback is awaited with the
    estimate BEFORE any log mutation:
    `true` proceeds; `false` cleanly ABORTS the whole append — no event appended,
    nothing inscribed, the asset left byte-identical (abort-before-mutate). A declined
    append throws `PROVENANCE_APPEND_DECLINED` and emits the new `cel:inscribe-declined`
    event; a subsequent append still works (no poisoned state).

  No defer/re-anchor path: btco is the final layer with no hosted fallback, so the
  only control is proceed-and-pay or abort. Off-btco (did:cel/did:webvh) appends are
  unaffected — they inscribe nothing, so the gate is a no-op.

- 73eac12: Guard the double-inscription hazard with a single shared keyed lock (#303). A new `OperationLock`, keyed by the canonical DID and shared via SDK config, is claimed at the money-spending inscription path so `LifecycleManager.inscribeOnBitcoin` and `MigrationManager` migrations of the same DID can no longer both broadcast paid commit/reveal pairs — replacing the two uncoordinated per-instance in-memory Sets that didn't see each other.
- b1c05f0: Content-as-ordinal, provenance-in-metadata (#407 phase 2). The did:btco
  anchoring inscription now BECOMES the asset: its content is the asset's current
  media (the most-recent resource's bytes) and its CBOR metadata carries the
  byte-light provenance (the did:btco DID document with its `#cel` anchor + the
  full CEL log). The verifier reads the `#cel`/witness commitment from inscription
  metadata (falling back to content for phase-1 inscriptions) and adds a
  content-as-ordinal gate binding the on-chain media to the log's most-recent
  resource hash. A new `LifecycleManager.resolveAssetFromSat(satoshi)` reconstructs
  and fully verifies an asset — provenance and current media — from a bare
  satoshi, with no envelope and no host. Provenance is now recoverable from
  Bitcoin alone. Pure-reference assets (no inline media) inscribe the DID document
  as content and carry no media on-chain. `OrdinalsProvider.createInscription`
  gains a `metadata` parameter (and a `{ content, metadata }` deferred-builder
  return), and `getInscriptionById` surfaces inscription metadata.
- dbe3f10: Ownership is the satoshi, not a CEL event. `transferOwnership` is now a pure Bitcoin sat move that writes nothing to the Cryptographic Event Log — a buyer never inscribes to receive, own, or resell an asset. The CEL is the authorship/provenance record only.

  - **Breaking:** `claimOwnership` is renamed `authorizeSigner` and reframed as _optional_ author-enablement (establishing a signing key to author new provenance); you own an asset by holding its anchoring satoshi, not by calling this.
  - **Breaking:** `ProvenanceChain.transfers`, the transfer query API (`getTransfersFrom`/`getTransfersTo`/`ProvenanceQuery.transfers()`/`TransferQuery`), and the `transferCount` summary field are removed — ownership history lives on the sat's UTXO chain, not the CEL.
  - **New:** `LifecycleManager.getCurrentOwner(asset)` reads the current owner live from the anchoring satoshi (`{ address, outpoint } | null`; throws `ORD_PROVIDER_REQUIRED` only when no ordinals provider is configured; fails open to `null` for non-`did:btco` assets, malformed bindings, or providers without an owner index).
  - The `transfer` CEL event type is now legacy/read-only: verifiers MUST still accept it (existing logs verify unchanged), writers MUST NOT emit it. The transfer CLI command is removed.

  This reverses the earlier decision that made `transfer` a first-class CEL event, re-aligning the implementation with "ownership moves only on Bitcoin."

- 0e6674a: Per-event real-time chain-recoverability (#407 phase 3). Once an asset is on
  did:btco, every authorship append now inscribes on the anchoring sat as it
  happens: `addResourceVersion` inscribes the new event (content = the new media,
  metadata = the event delta + the updated did:btco doc with a fresh `#cel` head),
  and rotations continue to reinscribe. The sat's inscription chain IS the
  always-current log — no point-in-time staleness. `resolveAssetFromSat` now WALKS
  that chain: it enumerates the sat's inscriptions, orders them strictly by
  confirmed block height (fail-closed on a missing height), concatenates each
  inscription's events (a full `celLog` snapshot is a checkpoint; an `events` delta
  extends it) into the full current log, reattaches each on-chain-anchored event's
  bitcoin witness proof, and runs the SAME `verifyEventLog` gate as any log — so a
  gap, a chain-inconsistent inscription, or tampered metadata fails closed.
  `QuickNodeProvider`/`OrdHttpProvider` `getInscriptionById` now decode inscription
  CBOR metadata (present-but-undecodable → clear fail-closed error). btco authorship
  appends are now paid Bitcoin operations: each surfaces a `cel:inscribe-cost`
  estimate, and a btco append with no ordinals provider degrades to a hosted append
  with a `cel:append-inscribe-skipped` signal. Provenance is now real-time
  recoverable from Bitcoin alone.
- a4e440f: Add `QuickNodeProvider`, a production `OrdinalsProvider` backed by a QuickNode Bitcoin endpoint with the Ordinals & Runes add-on. Supports inscription/sat reads (`ord_getInscription`, `ord_getContent`, `ord_getSat`), transaction broadcast (`sendrawtransaction`), confirmation status (`getrawtransaction` + `getblockheader`), and fee estimation (`estimatesmartfee`, converted to sat/vB). Inscription creation/transfer fail loudly since QuickNode does not build or sign transactions — build locally and submit via `broadcastTransaction`. `createOrdinalsProviderFromEnv()` now selects this provider when `QUICKNODE_ENDPOINT` is set.
- e571787: Resource versions are now signed CEL `update` log events instead of advisory
  envelope metadata. `OriginalsAsset.addResourceVersion` is now **async** and
  appends a signed `update` event (via a controller signer bound by
  `LifecycleManager`), degrading with `cel:append-skipped` when no signing key is
  available. `verifyEventLog` gains a resource-update branch that checks
  per-resourceId hash continuity (seeded from genesis) and derives the new content
  hash inline, so a buyer can verify every post-genesis version offline.

  **BREAKING:** `addResourceVersion` returns a `Promise<AssetResource>` (await it),
  and the advisory `AssetEnvelope.unverified.resourceUpdates` field is removed —
  `serialize()` no longer emits it and `loadAsset` folds resource versions from the
  verified log. Regenerate any persisted envelopes that carried it.

- a546db1: `inscribeOnBitcoin` can now inscribe the genesis did:btco onto a caller-chosen
  funding UTXO whose first sat becomes the DID: the sat is derived from the
  provider's sat index (`getFirstSatOfOutput`) and the inscription is
  deterministically constructed to land on it, with the commit txid computed
  locally from the caller `BitcoinSigner`'s broadcast-ready tx. Correctness is
  established at derive time (fire-and-forget) — there is no post-broadcast
  re-check; the caller owns confirmation monitoring, and a post-commit reveal
  failure throws with recovery data (`revealTxHex`) so committed funds are never
  stranded. Callers now control the permanent `did:btco:<sat>` identity instead of
  accepting an arbitrary provider-selected sat. The legacy `inscribeOnBitcoin(asset)` /
  `(asset, feeRate)` path is unchanged. (#369)
- 2443dc2: Add first-class `network: 'testnet'` (testnet4) support. A testnet-configured SDK mints `did:btco:test:<sat>` identifiers and validates `tb1` testnet addresses; the config/DID-identity network unions and prefix maps accept `'testnet'` across `types`, `btcoDid`, `createBtcoDidDocument`, `DIDManager`, `LifecycleManager`, `BitcoinManager`, `BtcoCelManager`, and `bitcoin-address`. The Bitcoin transaction layer already mapped `testnet` → `TEST_NETWORK`. `QuickNodeProvider` accepts `expectedNetwork: 'testnet'` for testnet4 reads/broadcast.
- a546db1: `OriginalsAsset.verify()` now fails closed for hosted (URL-only) resources whose integrity cannot be confirmed. Previously, a resource that carried only a `url` (no inline `content`) silently passed on a structural hex-shape check whenever no `fetch` was injected or the fetch threw. Now a fetch error, a hash mismatch, or the absence of an injected fetcher for a hosted resource all cause verification to return `false` rather than silently pass (fixes #368).

  This closes a tamper-evidence hole in the did:webvh layer, whose entire purpose is HTTPS-hosted, hash-addressed content. Inline-content assets (did:peer / did:cel with embedded bytes) are unaffected — they never reach the URL branch. A resource carrying both `content` and `url` still verifies via the authoritative inline path.

  Behavior change: callers verifying did:webvh (hosted) assets must now pass a `fetch` implementation to `verify({ fetch })`; without one, hosted resources are treated as unverifiable and verification fails.

#### Fixes and hardening

- 9d3c682: Fail loudly instead of fabricating on-chain data in the live Ordinals providers. `OrdHttpProvider` write-path methods (`broadcastTransaction`, `getTransactionStatus`, `estimateFee`, `createInscription`, `transferInscription`) and all `OrdNodeProvider` methods now reject with a `StructuredError` (`*_NOT_IMPLEMENTED`) rather than returning hardcoded placeholder txids, fees, or empty resolution results.
- c23eeef: Fix timing race in `BatchOperationExecutor` fail-fast mode: backoff sleeps are now interruptible via `AbortController`, so a sibling that exhausts its retries and aborts the batch immediately wakes any peers sleeping in backoff rather than requiring their full delay to elapse. This eliminates a race where, under CPU load, item 1's backoff could expire before item 0 had set the abort flag, causing item 1 to start a retry it should never have run.
- db8beba: BBS+ (`bbs-2023`) review follow-ups: `createProof` defaults `mandatoryPointers` to the document's binding field (`/issuer` for credentials, `/holder` for presentations, empty otherwise) so derived proofs stay bound out of the box without throwing on non-credential documents; `DataIntegrityProofManager.createProof` dispatches `bbs-2023` (symmetric with `verifyProof`); `checkProofExpectations` matches `expectedDomain` against string or array `domain`; add and enforce `expectedPresentationHeader` for derived-proof anti-replay, and fail closed when a base proof is presented where a fresh presentation header is required; `Verifier.verifyCredential` forwards the anti-replay/binding options (`expectedChallenge`/`expectedDomain`/`expectedPresentationHeader`/`expectedController`) to the cryptosuite; `jsonPointerToPaths` no longer coerces numeric-looking object keys; `skolemizeExpandedJsonLd` no longer throws on a `null` element; `verifyProof` shares one binding/expectation/key-resolution pass with `verifyDerivedProof` (no duplicated checks or double DID-key resolution); and `CredentialManager.deriveSelectiveProof` now reports mandatory-but-revealed fields (e.g. `/issuer`) as disclosed rather than hidden.
- fbaf69a: Sign the anchoring sat on the secondary btco writer (`BtcoCelManager.migrate` /
  `cel migrate` → btco), completing the anchored-sat binding for every btco path
  and closing the known follow-up (#397) from the Part A cutover. The migrate-to-btco
  CEL event now uses a pin-sat-first inscribe: `bitcoinManager.inscribeData({ buildContent })`
  pins the satoshi before the reveal, so the event body can sign
  `data.to = did:btco:<network>:<sat>` and inscribe the asset's btco DID document
  (whose `#cel` OriginalsCelAnchor commits to that event's chain digest and IS the
  Bitcoin witness artifact, with the `did:cel` back-linked in `alsoKnownAs`). This
  un-quarantines the `BtcoCelManager` btco verifiability path — logs it produces now
  pass `verifyEventLog` instead of failing `UNBOUND_ANCHOR`.

  Fails closed: the sat signed into `data.to`, the sat the inscription landed on, and
  the sat the witness proof carries must all agree, or `migrate` throws rather than
  emitting a mis-anchored log. The witness proof satoshi is normalised to a string
  (the verifier only recognises string sats), and a `lockKey` is passed to
  `inscribeData` so a concurrent inscription of the same asset is rejected before
  broadcast rather than double-paying. The verifier and the production
  `LifecycleManager.inscribeOnBitcoin` path are unchanged.

- 6bb75c1: fix: unify the per-asset CEL-log lock so `addResourceVersion` and lifecycle
  appends can't clobber each other (#400)

  Per-asset CEL appends were serialized by two mutually-invisible locks:
  `OriginalsAsset.#appendChain` (for `addResourceVersion`) and
  `LifecycleManager.inFlightAssets` (for publish/inscribe/rotate/authorize). A
  concurrent `addResourceVersion` and a lifecycle op could interleave across
  await points and clobber each other's signed append (an event silently
  dropped, or a stale-chained event that fails verification).

  Fix: `OriginalsAsset` exposes a `runExclusive()` backed by the existing
  `#appendChain` mutex — now the SOLE per-asset CEL lock — and every lifecycle
  log-mutating op runs its append span (including rollback) through it, taken
  after the non-blocking `inFlightAssets` guard (no lock cycle; guard still
  throws OPERATION_IN_PROGRESS for concurrent same-asset lifecycle ops).

- 784d0ea: Fix a deny-only front-running weakness in did:cel first-anchor-wins uniqueness (#402). `verifyUniqueness` counted **any** inscription that back-linked the did:cel via `alsoKnownAs`, so a non-controller could inscribe `{alsoKnownAs:["did:cel:Z"]}` on their own earlier sat and permanently trip `NON_CANONICAL_ANCHOR`/`AMBIGUOUS_CANONICAL` on an honest mint (deny-only — no theft). Now a competing anchoring on a different sat counts only if its inscribed did:btco document is signed by a key in the log's authorized-key history (genesis controller + rotations); the log's own anchored sat always counts. A bare or unauthorized-key back-link is ignored, so it can no longer deny a mint. Legit controller-signed dupe detection and all fail-closed behavior are preserved.
- d0d88e9: Define the `ResourceMigrated` credential's subject terms in the Originals JSON-LD context (#371). `LifecycleManager.publishToWeb` emits a `ResourceMigrated` credential (attached to `asset.credentials`) whose subject keys — `migratedTo`, `resourceId`, `fromLayer`, `toLayer`, `migratedAt` — the declared `https://originals.build/context` didn't define, so `@vocab` silently absorbed them into a different namespace (`…/vocab#X`) than the explicitly-defined terms (`…/X`). The context now defines them, and a test asserts the emitted `ResourceMigrated` credential's type + every subject key is explicit, guarding against a new field shipping without a context entry.

  Scoped to `ResourceMigrated` because it is the only credential the live lifecycle emits — verification is CEL-based (`verifyEventLog` never reads credentials), and the other `CredentialManager` factories (`MigrationCompleted`/`OwnershipTransferred`/`ResourceCreated`/`ResourceUpdated`) and `KeyRecoveryCredential` have no internal callers. Whether that legacy VC surface stays is the VC-vs-CEL question in #370/#405.

- 06490bb: did:cel uniqueness — first-anchor-wins. A btco-anchored did:cel log now verifies
  only when its anchored sat is the canonical one (the sat of the log's earliest
  on-chain anchoring, lowest confirmed block height grouped by sat), closing the
  malicious-controller duping case where one did:cel is signed onto two sats. Adds
  the `getAnchoringsForDidCel(didCel)` provider capability (implemented on
  OrdMockProvider) and back-links the did:cel in the inscribed btco document's
  alsoKnownAs so anchorings are enumerable. Fail-closed: a provider that cannot
  enumerate or an anchoring missing a block height → UNIQUENESS_UNVERIFIABLE; a
  same-block tie between different sats → AMBIGUOUS_CANONICAL; a non-canonical sat
  → NON_CANONICAL_ANCHOR. Follow-up to the signed-anchored-sat binding.

  Compatibility note: because the check is part of the btco verification contract
  (not opt-in), a btco-anchored did:cel log whose inscribed document predates this
  release and therefore lacks the did:cel back-link in alsoKnownAs will now fail
  UNIQUENESS_UNVERIFIABLE until re-anchored with the current writer shape.

- 8f73929: DID hardening: hash long did:peer suffixes on peer→webvh migration to avoid `ENAMETOOLONG`; fail closed (`unresolvable`) in the btco resolver when the newest inscription is unreadable instead of serving a stale document; pin btco `content_url` fetches to the configured origin and reject non-http(s) schemes/redirects (SSRF); enforce `keyPair`/`externalSigner` mutual exclusion and omit the empty `keyPair` placeholder when an external signer is used; throw instead of minting a keyless `did:btco` when a verification-method multikey cannot be decoded.
- 49cf1d5: Internal refactor (no behavior change): extract `buildResourceManifestService` so the `#resources` `OriginalsResourceManifest` service is constructed in one place instead of being duplicated verbatim in the btco migrate (`inscribeOnBitcoin`) and rotate/authorize (`buildRotatedBtcoDoc`) paths, preventing the two from drifting. The helper's return shape is pinned by an explicit type.
- e236aee: Correct the misleading lifecycle layer label: a did:cel genesis asset now reports `currentLayer: 'did:cel'` instead of `'did:peer'`. `LayerType` gains `'did:cel'` (`'did:peer' | 'did:cel' | 'did:webvh' | 'did:btco'`), and `OriginalsAsset.determineCurrentLayer` maps a `did:cel:` id to `'did:cel'`. The migrate transition table, the publish/inscribe genesis-layer gates, `replayProvenance`, and envelope restore all accept `'did:cel'` as the genesis layer (same migration targets as legacy `'did:peer'`).

  Legacy `did:peer` assets are unchanged — they still report `'did:peer'` and migrate identically. The `ResourceMigrated` publication credential's `fromLayer` is unchanged (spec non-goal: credentials are untouched). did:cel derivation, verification, ownership, and credentials are all unaffected.

- 15faa98: Migration/lifecycle hardening: fix per-item options merge in `MigrationManager.migrateBatch` (per-item `sourceDid`/`targetLayer` no longer clobbered); persist checkpoints and the signed audit trail through shipped storage adapters via a canonical `putObject/getObject` shape (with legacy `put/get` and tombstone/index fallbacks); add a concurrency guard to `transferOwnership` and duplicate-asset detection to `validateBatchTransfer`; make fail-fast batch modes actually stop and return a stable `BatchError` snapshot; implement `atomicRollback` for the publish path; reclaim `FAILED`/`QUARANTINED` states in `StateTracker.cleanupOldStates`; and validate partial-mode storage capability in `StorageValidator`.
- 7d02dc8: Harden `noble-init` so importing the SDK never white-screens a browser app. Under some ESM bundlers the `@noble/ed25519` / `@noble/secp256k1` module namespace is frozen (non-configurable, `hashes` reads `undefined`); the previous init did a raw `Object.defineProperty(mod, 'hashes', …)` that threw `Cannot redefine property: hashes` at import time. Initialization now routes `hashes` creation through the existing `safeSetProperty` (which cannot throw) and skips with a one-time `console.warn` when the namespace can't be configured, instead of crashing every consumer that merely imports the SDK.
- a07ff36: `createOrdinalsProviderFromEnv` now fails fast when `USE_LIVE_ORD_PROVIDER=true`
  but `ORD_PROVIDER_BASE_URL` is unset, blank, or left at the documentation
  placeholder `https://ord.example.com/api`, throwing
  `StructuredError('ORD_PROVIDER_BASE_URL_REQUIRED')` instead of silently building
  a live provider aimed at a nonexistent host. Also corrects a stale signet
  integration test to assert `OrdinalsClient.estimateFee` throws (its hardened
  behavior) rather than returning a fabricated positive fee rate. Related cleanup
  from #328.
- dbe3f10: Harden CEL verifier ordering checks against provider-order fail-open (PR #395 review). The non-cooperative rotation check (d) and the head-freshness "newest anchor" selection now order inscriptions by per-inscription `blockHeight` (via `getInscriptionById`) instead of trusting `getInscriptionsBySatoshi`'s documented oldest-first list order, so a provider returning newest-first can no longer accept a pre-anchor inscription or mask a truncated log. Missing block heights fail closed; same-block ties fall back to list order. Behavior change: an UNCONFIRMED reinscription (whose `blockHeight` is null until it has ≥1 confirmation on OrdHttp/QuickNode) is now rejected by these ordering checks until it confirms — intended, fail-closed.
- 9e61052: Three provenance/money-safety fixes:

  - Verify inline resource content against its declared hash in `createAsset`, `publishResources`, and `inscribeOnBitcoin`, rejecting with `RESOURCE_HASH_MISMATCH` before anything is written, attested, or inscribed (#347).
  - SSRF-harden `OrdinalsClient` (the SignetProvider read path): pin indexer-supplied `content_url` to the configured endpoint's origin, refuse redirects, bound request time, cap response sizes, and cap/batch per-satoshi content downloads (#343).
  - Size transaction inputs by script class (P2WPKH 68 vB, P2TR 57.5 vB, P2WSH a conservative 120 vB) and outputs by destination address class in all fee estimators, so P2WSH-funded commits no longer underpay the requested fee rate and stall (#344).

- 9dddc24: QuickNodeProvider: recognize `testnet4` (and `testnet3`) as the `testnet` network in its `getblockchaininfo.chain` guard. Modern bitcoind reports `chain: "testnet4"`, which previously failed the network check with a false "endpoint serves a different chain" error.
- ae15309: fix: accept `network: 'testnet'` in the `OriginalsSDK` constructor

  `OriginalsConfig.network` has always included `'testnet'` and the entire
  Bitcoin layer handles it (BitcoinManager→`did:btco:test`, transfer→signet
  validation, address validation), but the constructor's validation array
  omitted it — so `OriginalsSDK.create({ network: 'testnet' })` threw
  `Invalid network`. This bricked the landing demo (and any testnet4 consumer)
  whenever a testnet network was configured. The guard now accepts `testnet`.

- 06644c5: Batch of verification, event, and provider hardening fixes:

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

- be4c5b6: Credential verification hardening: the legacy verification path now fails closed for revoked/compromised verification methods (no `resolveDID` fallback that ignored retirement markers), and Data Integrity proofs must declare `type: "DataIntegrityProof"` — `verifyProof` rejects a mismatched/missing proof type and `createProof` throws symmetrically.
- f10e112: Standardize on W3C VCDM 2.0 and mark the migration subsystem experimental.

  **BREAKING (#300 — VCDM 2.0 only):** `validateCredential` now requires the
  `https://www.w3.org/ns/credentials/v2` context and rejects credentials that
  present only the VCDM 1.1 (`https://www.w3.org/2018/credentials/v1`) context
  (reversing the 1.1 acceptance added in #264). All SDK-emitted credentials now use
  the 2.0 context and the `validFrom` timestamp instead of `issuanceDate`:
  resource credentials, chained credentials, presentations, Bitstring status-list
  credentials, and key-recovery credentials. The 1.1 JSON-LD context remains
  preloaded so previously-issued 1.1 credentials can still be read/verified
  cryptographically, but it is no longer accepted at the structural gate. The
  `VerifiableCredential` type gains optional `validFrom`/`validUntil` and marks
  `issuanceDate`/`expirationDate` as deprecated legacy fields. Fixes a latent
  signing bug where `StatusListManager` emitted a v2 context with `issuanceDate`,
  a term the v2 context does not define (safe-mode canonicalization would fail).

  **BREAKING (#279 — migration subsystem experimental):** `MigrationManager` is no
  longer re-exported from the package entry point. It is experimental and unused in
  production — `OriginalsSDK`/`LifecycleManager` run their own migration flow and
  never use it — so its checkpoint/rollback/audit machinery protected no production
  path. It remains importable from its module path for experimentation. Only the
  `MigrationError` type stays exported (the public event API references it).

- 7f4c42d: Fix the did:webvh write paths to match the options didwebvh-ts actually consumes: `updateDIDWebVH` now translates the merged document into the named update options instead of passing an ignored `doc` (every update was a signed no-op, #338); key rotation and recovery carry forward all non-signing verification methods with their keyAgreement/capability relationships instead of wiping them, and enforce Ed25519 on the new update key (#339); the internal key-pair create/update/rotate paths publish the signing verification method as `#key-0` so the authorized `authentication`/`assertionMethod` fragments reference a VM that exists and third-party proof-purpose verification succeeds (#334). Update fields didwebvh-ts cannot express are now rejected loudly instead of silently dropped.
