# Follow-up items

Status update: items 1–19 were triaged and addressed in the follow-up pass on
branch `claude/follow-up-items-kjoaqi`; each entry records the decision taken.
Items 20–21 (surfaced by the later #234 correctness pass) remain open.

## 1. `did:btco` resolution ignores the network encoded in the DID — RESOLVED

`DIDManager.resolveDID` now parses the network from the DID string
(`did:btco:reg:`/`did:btco:sig:`, unprefixed = mainnet) and constructs the
`OrdinalsClient` with it. `did:btco:test:` falls back to the configured
network because `OrdinalsClient` has no testnet variant.

## 2. `migrateToDIDWebVH` left VM ids/controllers on the old `did:peer` — RESOLVED

The migrated document is now internally consistent: `verificationMethod[].id`
and `.controller`, plus `authentication`/`assertionMethod`/`keyAgreement`/
`capabilityInvocation`/`capabilityDelegation` references, are rewritten from
the old DID to the new `did:webvh:...`. Relative (`#0`) and foreign-DID
references are preserved. Development domains with ports are percent-encoded
(`localhost:8080` → `localhost%3A8080`), matching the rest of the SDK.

## 3. `did:btco` anchoring was never cryptographically verified — RESOLVED (gating)

Decision: **always require verification**. `verifyEventLog` now treats
`bitcoin-ordinals-2024` witness proofs as GATING on the default path: the
proof's inscription must exist, be carried by the claimed satoshi, and its
content must commit to the event's digest — checked through an
`ordinalsProvider` passed via `VerifyOptions`. A btco log without a provider
fails verification with a clear error (offline replay of btco logs no longer
verifies — by design). `OriginalsCel.verify` auto-threads the configured
`BitcoinManager`'s provider. The custom-`verifier` path is unchanged (caller
owns proof semantics). Note: the CEL CLI `verify` command has no provider
plumbing yet, so btco logs fail closed there with the explanatory error.

## 4. Fee estimators assumed segwit inputs; legacy inputs under-estimated — RESOLVED (reject)

Decision: **reject non-segwit funding UTXOs**. `isSegwitScriptPubKey`
(src/bitcoin/utxo.ts) classifies witness programs; commit-transaction
building, `selectUtxos`, and `PSBTBuilder` now exclude/reject legacy
(P2PKH/P2SH) funding UTXOs with clear errors instead of silently underpaying
the requested fee rate. The per-input constant is unified at ~68 vB
(P2WPKH) across all four estimators (utxo.ts previously used 148 vB).

## 6. `encodeBase64UrlMultibase` used prefix `z` for base64url — RESOLVED (breaking)

Decision: **hard switch to `u`**. The helper now emits and accepts only the
spec-correct `u` multibase prefix. Legacy `z`-prefixed base64url proof values
and keyless audit-record hashes no longer verify — re-issue/re-sign where
needed.

## 7. `createResource` with a reused explicit `id` discarded history — RESOLVED (throw)

`ResourceManager.createResource` now throws when an explicit `options.id`
already exists, directing callers to `updateResource`/`importResource`.

## 8. `MemoryStorageAdapter` composite key collision — RESOLVED

Domain and path are percent-encoded before joining with `::`, so the
delimiter cannot occur inside either component.

## 9. `MetricsCollector` Prometheus family merge on sanitization collision — RESOLVED

Colliding sanitized operation names are disambiguated with a short stable
hash suffix, so `# HELP`/`# TYPE` lines stay unique per family.

## 10. `EventLogger` advertised levels for unsubscribed events — RESOLVED

`subscribeToEvents` now subscribes to `migration:*` and `batch:progress`
(they exist in `EventTypeMap`), logging them generically, so the advertised
default config levels actually apply.

## 11. BBS+ derived-proof message indexing — PARTIALLY RESOLVED

`verifyDerivedProof` now fails closed when the disclosed document's field
count disagrees with the derived proof's disclosed indexes (previously a
silent positional misalignment), and the ordering contract with
`buildDisclosedDocument` is documented. Full path-binding between disclosed
fields and original message indexes remains for the BBS+ implementation work
(the underlying `BbsSimple` primitives are still unimplemented stubs, so this
path stays unreachable).

## 11b. did:webvh logs created under didwebvh-ts ≤2.7.5 do not verify under 2.8.0 — DOCUMENTED

Data-migration issue, not an SDK code fix. See
`docs/WEBVH_LOG_COMPATIBILITY.md` for the affected-log criteria and options
(re-create affected DIDs, or upstream backward-compat in didwebvh-ts).

## 12. did:webvh resolution hardcoded to Ed25519 — RESOLVED (Ed25519-only)

Decision: **enforce Ed25519-only**. `assertEd25519WebVHKeys`
(src/did/WebVHManager.ts) rejects non-Ed25519 `verificationMethods` and
`updateKeys` up front in both create paths (WebVHManager and DIDManager) and
in `updateDIDWebVH`, with an error explaining that resolution verifies DID
logs with Ed25519.

## 13. CEL create-event key not bound to a self-certifying `data.did` — RESOLVED (scoped)

`verifyEventLog` now enforces, for create proofs whose verificationMethod is
a `did:key`, that the signing key is embedded in a self-certifying `data.did`
(did:key, or long-form did:peer:4). To make the binding hold by construction,
`PeerCelManager` embeds the signer's key in the generated did:peer (extracted
from a did:key config verificationMethod, or discovered via a probe
signature), plus a random per-asset key so DIDs stay unique per asset.
Remaining TOFU cases (documented in the code): resolver-backed create
verificationMethods (did:webvh etc.), short-form did:peer:4, and
non-self-certifying DID methods. Logs created by older SDK versions with a
random-key did:peer and a did:key signer no longer verify (pre-1.0 breaking
change, accepted).

## 14. `batchInscribeOnBitcoin({ singleTransaction: true })` shared one sat across N assets — RESOLVED (reject)

Decision: **an asset must be tied to its own sat**. The identity-sharing
single-transaction mode is removed; passing `singleTransaction: true` throws
`BATCH_SINGLE_TX_UNSUPPORTED`. The default batch mode inscribes each asset in
its own transaction with its own inscription/satoshi.

## 15. CEL CLI migrate/transfer emitted network-less `did:btco:<sat>` — RESOLVED

The network is recorded in the signed btco migration data
(`BtcoMigrationData.network`) since the earlier correctness pass, so the CLI
display helpers now derive the network-scoped DID from the log itself via the
shared `btcoDidFromSatoshi` helper (src/cel/btcoDid.ts). Legacy logs without
a recorded network default to the bare mainnet form.

## 16. btco `getCurrentState` required a `BitcoinManager` it didn't need — RESOLVED

`BtcoCelManager`'s constructor now takes an optional `BitcoinManager`; only
the inscribing write path (`migrate`) requires one. `OriginalsCel` constructs
the manager without it for reads, so replaying a persisted peer→webvh→btco
log needs no Bitcoin access. Legacy logs that do not record their network in
the signed data still fail closed with a clear error when no manager can
supply it.

## 17. `WebVHCelManager.getCurrentState` keyed migration detection off `targetDid` — RESOLVED

Detection now keys off `sourceDid + layer`, matching
`OriginalsCel.getCurrentLayer` and `BtcoCelManager`.

## 18. `WebvhToBtcoMigration` satoshi fallback fabricated a txid-derived value — RESOLVED

The fallback is removed; a provider that omits the satoshi now produces a
clear "did not return a satoshi ordinal" error instead of an invalid DID.

## 19. `proofPurpose` not validated at verification time — RESOLVED

`Verifier.verifyCredential` requires `proofPurpose: 'assertionMethod'` and
`verifyPresentation` requires `proofPurpose: 'authentication'`; when the
verification method's DID document resolves, the method must also be listed
under the corresponding relationship. The legacy `CredentialManager` verify
path enforces the same purpose check.

## Open items (from the #234 correctness pass — not yet addressed)

## 20. `MAX_SATOSHI_SUPPLY` is the theoretical cap, not the real issued supply (LOW)

- **Where:** `packages/sdk/src/utils/satoshi-validation.ts:7`
  (`MAX_SATOSHI_SUPPLY = 2_100_000_000_000_000`).
- **What:** The bound is 21e6 × 1e8 (theoretical 21M BTC), ignoring halving
  rounding. The real total ever issued is `2_099_999_997_690_000` sats, so the
  highest valid ordinal is `2_099_999_997_689_999`. `validateSatoshiNumber`
  therefore accepts ~2.31M non-existent satoshi numbers in
  `[2_099_999_997_690_000, 2_100_000_000_000_000]`.
- **Why deferred:** Low severity (resolution simply fails later for a
  non-existent sat). Tightening the bound flips security/penetration tests that
  deliberately encode `2100000000000000` as "max valid satoshi"
  (`tests/security/bitcoin-penetration-tests.test.ts:274,526`,
  `tests/unit/utils/utils-coverage.test.ts:178`) from valid→invalid, so it is a
  tested-contract change plus a theoretical-vs-actual-cap decision, not a
  one-line minimal fix. Needs its own PR that also updates those expectations.

## 21. `did:btco` lifecycle binding is constructed network-blind (MEDIUM, spec ambiguity)

- **Where:** `packages/sdk/src/lifecycle/LifecycleManager.ts` (inscribeOnBitcoin
  binding) and `packages/sdk/src/lifecycle/BatchLifecycleOperations.ts` (batch
  binding). Both build `did:btco:${satoshi}` (bare mainnet form) regardless of
  network.
- **What:** For a regtest/signet inscription the recorded
  `asset.bindings['did:btco']` is the mainnet form, not `did:btco:reg:<sat>` /
  `did:btco:sig:<sat>`. The rest of the SDK (`createBtcoDidDocument`,
  `BtcoDidResolver`) is network-aware.
- **Why deferred:** Requires resolving a genuine network-authority ambiguity, so
  it is not a clearly-correct minimal fix:
  - `webvhNetwork` always defaults to `'pichu'` (mapped → mainnet) while an
    explicit `network` is preserved-but-warned, so the two can contradict.
  - The inscription itself runs on `config.network` (via `BitcoinManager`), which
    argues the binding should use `config.network`.
  - But `DIDManager.migrateToDIDBTCO` — the canonical btco-DID builder — prefers
    the `webvhNetwork` mapping, which yields a *different* answer (mainnet) for
    the common `network:'regtest'` + default-pichu config.
  - An existing test (`tests/unit/lifecycle/LifecycleManager.test.ts:44`)
    explicitly asserts `did:btco:123` (mainnet) for a `network:'regtest'` SDK,
    so any fix changes a tested contract.
  Fixing this well means deciding which network is authoritative for the binding
  and aligning `migrateToDIDBTCO`, the binding, and the test together — a design
  decision, surfaced here rather than chosen arbitrarily.
