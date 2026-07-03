# Correctness Loop Log

Branch: `claude/originals-sdk-correctness-4pn30u` (iterations 1–N, merged as #230–#233)
Branch: `claude/originals-sdk-correctness-osnfzp` (current)

## Iteration (osnfzp) 1 — 2026-07-03

### Ground truth
- Fresh clone, `bun install` + `bun run build`. Baseline fully green:
  `bun test` 3429 pass / 0 fail / 74 skip; `bun run typecheck` clean;
  `bun run lint` 0 errors / 87 warnings.
- Branch was even with `origin/main` (378a445); prior correctness work #230–#233
  already merged. No open PR for this branch — opened one this firing.

### Work items (fixed, each with a regression test that fails before / passes after)
- **utxo.ts `selectUtxos` ignored `hasResource`** (HIGH, fund/ordinal loss). Public
  `buildTransferTransaction` could spend a `hasResource: true` ResourceUtxo (no
  `inscriptions[]`) as a fee input. Now excludes both markers, matching the two
  sibling selectors. Tests: `tests/unit/bitcoin/utxo.selection.test.ts` (+3).
- **Multi-sig verification skipped revocation + expiration** (HIGH, verification
  bypass). `MultiSigManager.verifyMultiSig` now enforces the credential validity
  window and fails closed on a declared `BitstringStatusListEntry` it cannot
  check. Tests: `tests/unit/vc/MultiSigManager.test.ts` (+3).
- **`migrateToDIDWebVH` un-encoded port colon** (malformed DID). Now percent-encodes
  the port so the authority stays one segment. Tests:
  `tests/unit/did/DIDManager.test.ts` (+1).

### Verify
- Post-fix: `bun test` 3436 pass / 0 fail; typecheck clean; lint 0 errors / 87
  warnings (no new). Changeset added (`.changeset/correctness-loop-osnfzp.md`, patch).

### Deferred this firing (see FOLLOWUP.md #20, #21)
- MAX_SATOSHI_SUPPLY above real issued supply (LOW; changes a tested contract).
- Network-blind `did:btco` binding in Lifecycle/Batch (MEDIUM; network-authority
  spec ambiguity — an existing test asserts the mainnet form for a regtest SDK).

---


## Iteration 1 — 2026-07-02

### Ground truth
- `bun test` (fresh clone, after `bun install`): 3305 pass / 23 fail / 4 errors.
- All 23 failures + 4 errors had a single root cause: `packages/sdk/dist` did not exist.
  - `packages/auth` resolves `@originals/sdk` via the workspace package's built entry point.
  - `tests/integration/cel-cli.integration.test.ts` spawns `dist/cel/cli/index.js` as a subprocess.
  - After `bun run build`, re-ran the full suite (results below).
- `bun run lint`: 0 errors, 85 warnings.
- `bun run typecheck` (packages/sdk): clean.
- No open PR for this branch yet; branch tip == origin/main (8ac6c70).

### Work items
- Full-suite re-run after `bun run build`: **3380 pass / 0 fail / 74 skip** across 182 files. Suite is green; initial failures were environment-only (missing dist), no code change needed.
- Proactive correctness audit of vc/crypto, did, bitcoin, cel/lifecycle subsystems: in progress.

### Audit + fixes (this iteration)
Ran four parallel subsystem audits (vc/crypto, did, bitcoin, cel/lifecycle).
Fixed the confirmed correctness bugs, each with a regression test:

1. **HIGH — VC issuer/holder impersonation** (`2ec7c28`): `Verifier.verifyCredential`
   / `verifyPresentation` never bound `proof.verificationMethod` to the credential
   `issuer` / presentation `holder`. An attacker could sign with their own key while
   naming a trusted issuer and have it verify. Added `checkVerificationMethodController`
   gate + regression tests reproducing the attack.
2. **HIGH — did:webvh always resolved to null** (`57c21a1`): `DIDManager.resolveDID`
   passed no verifier to `didwebvh-ts`, which requires one; every valid did:webvh
   returned null. Pass `Ed25519Verifier`; regression test resolves a real served log.
3. **HIGH — CEL btco layer/DID/guard mis-detection** (`3435813`): after #228, btco
   migration events carry `sourceDid` not `targetDid`; four detectors still keyed off
   `targetDid`, so btco logs were seen as webvh (wrong resolvable DID, terminal-guard
   bypass, wrong transfer owner). Switched detectors to `sourceDid`; derive
   did:btco:<sat> from the witness proof. Regression tests for DID + terminal guard.
4. **MED — legacy verify skipped expiry; 64-byte Ed25519 signing broken** (`2a8a55b`):
   extracted shared `checkCredentialValidityPeriod` for the legacy path; fixed
   `slice(32)`→`slice(0,32)`. Regression tests for both.
5. **LOW — unbounded estimator fees; non-anchored btco DID marker** (`7e9d871`):
   applied `MAX_REASONABLE_FEE_RATE` to fee-oracle/provider estimates; added
   `(?![0-9])` boundary to the btco marker regex. Regression tests for both.

### Deferred (see FOLLOWUP.md)
- did:btco resolve network from config vs DID (latent — OrdinalsClient ignores network).
- migrateToDIDWebVH stale VM ids/controllers + unencoded port (design decision).
- did:btco witness anchoring not cryptographically verified (threat-model decision).
- fee estimators assume segwit inputs; legacy inputs under-estimated (scoped-out, own PR).
- BBS+ derived-proof indexing (latent — BBS+ path unreachable/unimplemented).

### Result
- Full suite after fixes: pending final confirmation (see next entry).
- No open PR yet; will push branch. All fixes preserve/strengthen crypto verification;
  none weaken validation or skip checks.

### Open items
- Push branch; monitor for CI/review comments.

## Iteration 2 — 2026-07-02

Opened PR #230; added a changeset (`bb00df8`) to satisfy the "Changeset present"
CI check (all other checks were already green). Subscribed to PR activity and
armed an hourly self check-in.

Ran three more subsystem audits over the areas iteration 1 didn't cover
(migration/validation/rollback, storage/events/resources, core/config/serialization/
provenance). Fixed the confirmed correctness bugs, each with a regression test:

1. **HIGH — migration audit-failure spuriously rolls back a completed migration**
   (`8ad4362`): the post-completion audit write lived inside the main try; a throw
   re-entered the failure path and rolled back a successful migration (success:false/
   ROLLED_BACK), risking a double-inscription on retry. Also: tracked state never
   advanced to ROLLED_BACK after rollback (getMigrationStatus disagreed with the
   result); `migrateBatch.startTime` recorded the batch end. Guarded both audit
   writes, advanced tracker state on rollback (auto + public `rollback()`), captured
   batch start time. Regression tests for all three.
2. **HIGH — network/webvhNetwork config footgun** (`17fc035`): `create({ webvhNetwork })`
   without an explicit network left network defaulting to mainnet, so Bitcoin ops +
   did:btco resolution ran on mainnet while did:btco creation used the tier network.
   Derive network from the tier when network isn't explicitly set. Regression test.
3. **MED/LOW — storage URL + asset hash** (`17fc035`): `LocalStorageAdapter.toUrl`
   used the raw domain while files were stored under a sanitized domain (URL pointed
   nowhere); `OriginalsAsset.verify` used an unanchored hex regex accepting non-hex
   hashes for URL-only resources. Fixed both with regression tests.

### Iteration 2 deferred (added to FOLLOWUP.md, items 6–10)
- base64url multibase `z` prefix (breaking wire-format change — needs migration plan).
- `ResourceManager.createResource` history overwrite on reused id (API-behavior decision, ~47 call sites).
- `MemoryStorageAdapter` `::` key collision (latent, low).
- `MetricsCollector` Prometheus name collision (latent, low).
- `EventLogger` dead default-config entries (informational).

### Result
- Suites run per fix all green; typecheck clean. Full-suite + lint re-run pending push.

---

Branch: `claude/originals-sdk-correctness-ws3gte` (continuation after #230 merged)

## Iteration 1 — 2026-07-02

### Ground truth
- Requested first: upgrade `didwebvh-ts` 2.7.5 → 2.8.0.
- After the upgrade, `bun test`: 3130 pass / 79 fail.
  - 63 failures: every did:webvh create/update/rotate/recover path threw
    `Key did:key:z6Mk... is not authorized to update.` inside didwebvh-ts.
  - 16 failures: CEL-CLI subprocess tests — environment-only (`packages/sdk/dist`
    missing in the fresh clone); green after `bun run build`, no code change.
- `bun run typecheck`: clean. `bun run lint`: 0 errors (87 warnings, pre-existing).
- No open PR for this branch yet; branch tip == origin/main (709c908).

### Work items
1. **didwebvh-ts 2.8.0 breaking change — `updateKeys` format.** 2.8.0's
   `isKeyAuthorized` compares each `updateKeys` entry against the *bare multikey*
   parsed from the proof's `did:key:` verification method (matching the did:webvh
   spec), where 2.7.5 stripped a `did:key:` prefix from `updateKeys` itself. The SDK
   passed `did:key:z6Mk...`-prefixed updateKeys everywhere, so every log entry
   failed authorization. Since `deriveNextKeyHash` hashes the updateKey string
   verbatim, pre-rotation `nextKeyHashes` had to move to the bare format too.
   - `WebVHManager`/`DIDManager`: pass bare `keyPair.publicKey` as updateKeys in
     create/appendKeyChange/appendKeyChangePrerotation; compute `nextKeyHashes`
     and the SDK-level pre-rotation guard hash over the bare key.
   - Added exported `normalizeUpdateKey()` and applied it to caller-provided
     `updateKeys` (external-signer paths), so the documented legacy
     `"did:key:z6Mk..."` input keeps working. Direct unit tests added
     (`tests/unit/did/webvh-prerotation.test.ts`), and existing external-signer
     tests that pass `did:key:`-prefixed updateKeys now cover the normalization
     end-to-end through didwebvh-ts resolution.
   - Updated 2 test assertions that asserted the old `did:key:`-prefixed
     nextKeyHash input (intentional behavior change tracking the spec).
2. Deferred: logs created/published under ≤2.7.5 store `did:key:`-prefixed
   updateKeys inside signed entries and will not verify under 2.8.0's stricter
   check — added to FOLLOWUP.md (item 11).

### Result
- Full suite: **3209 pass / 0 fail / 71 skip** across 171 files (post-build).
- Typecheck clean; lint 0 errors.

## Iteration 2 — 2026-07-02 (CI feedback on PR #231)

### Ground truth
- PR #231 opened; CI on 6f0128b: Typecheck/Lint/ESM green, two failures:
  - `Changeset present` — repo requires a changeset for SDK changes.
  - `Tests pass` — `@originals/auth#test` failed: 2 failures in
    `turnkey-did-creation.integration.test.ts` with the same 2.8.0
    "Key did:key:... is not authorized to update." error. Root cause: a third
    didwebvh-ts entry point missed in iteration 1 — `OriginalsSDK.createDIDOriginal`
    / `updateDIDOriginal` pass caller `updateKeys` straight through, and the auth
    package passes `signer.getVerificationMethodId()` (`did:key:z6Mk...`).

### Work items
1. Normalize caller-provided `updateKeys` via `normalizeUpdateKey` in
   `OriginalsSDK.createDIDOriginal` and `updateDIDOriginal` (matches the
   WebVHManager/DIDManager external-signer paths). Regression test added in
   `tests/unit/core/OriginalsSDK.test.ts` reproducing the auth package's usage
   (external signer + `did:key:`-prefixed updateKey) and asserting the log's
   `meta.updateKeys` stores the bare-multikey spec form.
2. Added changeset `.changeset/didwebvh-ts-2-8-updatekeys.md` (patch,
   @originals/sdk) for the `Changeset present` check.

### Result
- `@originals/auth`: 190 pass / 0 fail. Full turbo suite: 4/4 tasks green.
- Typecheck clean; lint 0 errors.

## Iteration 3 — 2026-07-02 (Macroscope review on PR #231)

### Review comments triaged
1. 🟠 High (OriginalsSDK.ts, updateDIDOriginal): normalizing `updateKeys` while
   forwarding caller-computed `nextKeyHashes` unchanged can silently break a
   pre-rotation chain — hashes commit to the exact updateKey string and cannot
   be normalized after hashing. **Actionable — fixed.**
2. 🟡 Medium (.changeset): patch bump documents a breaking change (old persisted
   logs no longer verify under 2.8.0). **Actionable — fixed** (patch → major).

### Work items
1. Added `assertBareUpdateKeysForPrerotation` guard to both
   `createDIDOriginal` and `updateDIDOriginal`: combining legacy
   `did:key:`-form updateKeys with `nextKeyHashes` now fails fast with a
   descriptive error instead of committing hashes that can never match a
   future normalized updateKey. Documented the format contract on both
   option interfaces; exported `computeNextKeyHash` and `normalizeUpdateKey`
   from the package index so callers can compute spec-form hashes.
2. Found while fixing: `createDIDOriginal` silently dropped declared options
   (`nextKeyHashes`, `portable`, `controller`, `alsoKnownAs`, `authentication`,
   `assertionMethod`, `keyAgreement`, `services`) — pre-rotation requested at
   create time was ignored entirely. Now forwarded.
3. Changeset bumped to major with an explicit BREAKING section.
4. Regression tests: full pre-rotation chain through the wrappers
   (create with nextKeyHashes → rotate to pre-committed key), guard rejection
   on both create and update paths.

### Result
- Full turbo suite green (0 fail), typecheck clean, lint 0 errors.

---

Branch: `claude/originals-sdk-correctness-n08sq0` (fresh off main @ 738dec2, includes merged #230 + #231)

## Iteration 1 — 2026-07-03

### Ground truth
- Fresh clone; `bun install`, then `bun run build` (dist was missing → 16 CEL-CLI
  subprocess tests fail without it; environment-only, no code issue).
- Full suite after build: **3216 pass / 0 fail / 71 skip** across 171 files.
- `bun run typecheck`: clean. `bun run lint`: 0 errors (87 pre-existing warnings).
- No open PR for this branch; branch tip == origin/main (738dec2).

### Work
- Baseline green. Launched 4 parallel subsystem correctness audits
  (vc/crypto, did, cel/anchoring, lifecycle/migration/storage) instructed to
  skip everything already in FOLLOWUP.md and to report only concrete,
  reachable, reproducible bugs. Triage of results pending.

### Audit + fixes (iteration 1)
Four parallel subsystem audits (vc/crypto, did, cel/anchoring, lifecycle/
migration/storage) instructed to skip FOLLOWUP.md items and report only
concrete, reachable, reproducible bugs. Fixed six confirmed correctness bugs,
each with a regression test that fails before the fix and passes after
(verified by stashing the src changes and re-running):

1. **MED (revocation bypass) — `verifyCredentialWithStatus` failed OPEN**
   (`src/vc/CredentialManager.ts`): when a credential declared a
   `BitstringStatusListEntry` that could not be evaluated (no status list
   supplied, or `checkStatus` threw on purpose-mismatch / out-of-range index /
   corrupt list), it left `verified: true` / `revoked: false` and returned only
   an error string — a caller gating on `verified`/`revoked` would accept a
   possibly-revoked credential. Now fails closed (`verified = false`),
   mirroring the Data Integrity path. Determinable revoked/suspended still
   leave `verified` true. Test: StatusListManager.test.ts.
2. **LOW (binding inconsistency) — legacy `verifyCredential` accepted an
   issuer-less self-signed did:key credential** (`resolveVerificationMethodMultibase`):
   the issuer-binding guards were gated on a truthy `issuerDid`, so a credential
   with no issuer + a self-certifying did:key VM verified unconditionally, while
   the DI path fails closed. Added an explicit fail-closed guard on missing
   issuer. Test: CredentialManager.test.ts.
3. **LOW-MED (version-history correctness) — `ResourceManager.getResourceVersion`
   indexed positionally** (`versions[version-1]`): `importResource` inserts by
   version number and permits gaps, so importing v1 then v3 made
   `getResourceVersion(id,2)` return v3 and `(id,3)` return null. Now matches by
   stored version number. Test: ResourceManager.test.ts.
4. **LOW (spec-fidelity) — `BtcoDidResolver` misclassified a DID document
   containing 🔥 as a deactivation tombstone**: deactivation was gated on a raw
   `content.includes('🔥')`, so a valid DID document carrying the emoji in any
   field (service description, name, …) was tombstoned. Now excludes content
   that parses to a valid DID document for the DID; only the human-readable
   marker form deactivates. Test: BtcoDidResolver.test.ts.
5. **MED (correctness) — CEL btco state derivation emitted a network-less
   `did:btco:<sat>` on regtest/signet** (`BtcoCelManager.getCurrentState`): the
   identifier was hardcoded to the mainnet form, so a regtest/signet asset
   pointed at the mainnet ordinals namespace. Now network-scoped
   (`did:btco:reg:` / `did:btco:sig:`) via the inscribing `BitcoinManager`
   (added a `network` getter). Test: BtcoCelManager.test.ts. The CLI display
   helpers (migrate/transfer) remain network-agnostic — deferred (FOLLOWUP #15).
6. **LOW (interop false-negative) — `multikey.decodeMultibase` rejected `u`
   base64url** while the CEL structural check accepts a `u` proofValue: a
   spec-valid base64url signature passed the structural gate but failed to
   decode and was rejected. `decodeMultibase` now accepts both `z` (base58btc)
   and `u` (base64url); unknown prefixes still fail closed. Test:
   Multikey.test.ts.

### Deferred (added to FOLLOWUP.md, items 12–15)
- did:webvh resolution hardcoded to Ed25519Verifier (multi-algo design decision).
- CEL create-event key not bound to self-certifying data.did (TOFU threat-model).
- single-transaction batch inscription shares one btco identity + no per-item
  atomicity (batch-semantics design decision).
- CEL CLI migrate/transfer display emit network-less btco DID (CLI plumbing;
  network not in the log).

### Result
- Full suite: **3222 pass / 0 fail / 71 skip** (was 3216; +6 regression tests).
- Typecheck clean; lint 0 errors (87 pre-existing warnings, none added).
- No open PR for this branch — will push and open one. All fixes strengthen or
  preserve verification; none weaken validation or skip crypto checks.

## Iteration 2 — 2026-07-03 (Macroscope review on PR #232)

Opened PR #232; subscribed to activity and armed an hourly self check-in. All
CI checks green (typecheck, lint, tests, coverage, ESM, changeset). Macroscope
Correctness Check posted three Medium findings — all valid, all fixed with
regression tests (each verified to fail against the iteration-1 commit):

1. **CEL btco DID was runtime-config-dependent** (BtcoCelManager): iteration 1's
   network fix derived the prefix from `this.bitcoinManager.network` at replay
   time, so replaying a persisted regtest/signet log under a differently
   configured SDK silently rewrote `state.did`. Now the network is recorded in
   the SIGNED migration data (known before inscription, unlike the satoshi) and
   read back during replay, with a runtime-config fallback only for legacy logs.
   State derivation is deterministic from the log. Tests: network recorded in
   signed data + replay under a mainnet manager still yields did:btco:reg:.
2. **`decodeMultibase` silently accepted malformed base64url** (Multikey):
   `Buffer.from('@@@','base64url')` returns empty instead of throwing, so a
   malformed `u` payload decoded to an empty array (the `z` branch throws). Now
   validates `^[A-Za-z0-9_-]+$` before decoding; malformed/empty `u` throws.
   Test: 'u@@@', 'u', 'u====' all throw.
3. **Tombstone guard bypass** (BtcoDidResolver): iteration 1's
   `!isDidDocumentForThisDid` guard could be evaded by appending a minimal
   `{"id":"<did>"}` object after a "BTCO DID: … 🔥" marker — it parsed to a
   matching-id object, skipped the tombstone branch, and fell back to an older
   document. Switched tombstone detection to the start-anchored marker PATTERN
   (`didPattern.test && includes('🔥')`), which correctly classifies both a
   DID-document-containing-🔥 (not a tombstone) and a marker-with-appended-JSON
   (a tombstone). Test: marker + appended JSON still deactivates.

### Result
- Full suite: **3224 pass / 0 fail / 71 skip**. Typecheck clean; lint 0 errors.
- Replied to all three review threads with the fixing commit SHA.

### Iteration 2 follow-up (2nd Macroscope round)
Macroscope flagged one more Medium: iteration-2's fix added `network` to the
GLOBAL metadata-exclusion list, so an ordinary (non-migration) update event
carrying an application-defined `network` field had it silently dropped from
`state.metadata`. Scoped the exclusion to btco migration events only (where
`network` is consumed explicitly). Regression test: a regular update with a
custom `network` field now preserves it. Full suite 3225 pass / 0 fail;
typecheck clean; lint 0 errors.

---

# Correctness Loop Log (branch `claude/originals-sdk-correctness-asdkdz`)

## Iteration 1 — 2026-07-03

### Ground truth
- Fresh branch at `origin/main` (561664d); prior correctness passes (#230, #232) already merged. No open PR for this branch, so the eval signal this iteration is the test suite + spec/protocol consistency (no PR review comments yet).
- After `bun install` + `bun run build`: full suite **3415 pass / 0 fail / 74 skip** (182 files). `bun run typecheck` clean. `bun run lint` clean (88 warnings, 0 errors).

### Audit
Ran four parallel subsystem audits (vc/crypto, did, bitcoin, cel/lifecycle), each told to exclude the items already logged in FOLLOWUP.md. Fixed every confirmed correctness bug with a regression test that fails before / passes after.

### Fixes (this iteration)
1. **HIGH — ordinal-loss in payment UTXO selection** (`utxo-selection.ts`):
   `selectResourceUtxos`/`selectUtxosForPayment` only excluded UTXOs flagged
   `hasResource === true`, never the first-class `inscriptions[]` array (what ord
   indexers actually populate) nor `locked`. A wallet UTXO carrying an inscription
   but no `hasResource` flag would be selected as a plain payment input, burning
   the ordinal. Now excludes inscription-bearing (via `inscriptions.length > 0`)
   and locked UTXOs, matching the sibling `utxo.ts` selector. Regression tests in
   `tests/unit/bitcoin/utxo-selection-new.test.ts`.
2. **MED — non-canonical `did:btco` identifiers** (`satoshi-validation.ts`,
   `createBtcoDidDocument.ts`, `DIDManager.ts`): `validateSatoshiNumber` trims/parses
   before validating, so `' 42 '` and `'007'` passed, but the DID was built from the
   raw argument → `did:btco: 42 ` (unresolvable) / `did:btco:007` (never matches the
   inscribed `did:btco:7`). Added `canonicalizeSatoshi()` and used it in both DID-
   building paths. Regression tests in `createBtcoDidDocument.test.ts` and
   `DIDManager.more.test.ts`.
3. **MED — network-blind satoshi extraction in transfer** (`LifecycleManager.ts`):
   `transferOwnership` fell back to `asset.id.split(':')[2]`, which returns the
   network tag `'reg'`/`'sig'` for `did:btco:reg:<sat>` / `did:btco:sig:<sat>` instead
   of the satoshi, so a regtest/signet transfer without a migration record looked up
   the wrong ordinal. Switched to the network-aware `parseSatoshiIdentifier`.
   Regression test in `LifecycleManager.transfer.unit.test.ts`.
4. **LOW — `hexToBytes` silently accepted malformed hex** (`utils/encoding.ts`):
   the per-byte `parseInt` NaN check let `'1g'`→`[0x01]`, `'aa1z'`→`[0xaa,0x01]`
   through. Added a strict `^[0-9a-fA-F]*$` guard. Regression tests in
   `encoding.test.ts`.
5. **LOW — lenient `statusListIndex` parsing** (`vc/StatusListManager.ts`,
   `vc/CredentialManager.ts`): `parseInt('5abc', 10) === 5` silently targeted the
   wrong revocation bit in `checkStatus`/`revoke`/`suspend`/`unsuspend`. Added a
   strict `parseStatusListIndex()` used at all four sites. Regression tests in
   `StatusListManager.test.ts`.

### Verify
- Full suite **3428 pass / 0 fail / 74 skip**; typecheck clean; lint clean.
- One flaky timing-based perf guard (`did:peer creation should not regress beyond 2x baseline`) failed once under full-suite CPU contention and passed in isolation (6/6) and on re-run; unrelated to these changes (no did:peer creation code touched).

### Deferred (added to FOLLOWUP.md, items 16–19)
- 16. `OriginalsCel.getCurrentState` on a btco log requires a BitcoinManager it doesn't need (design/dependency-structure).
- 17. `WebVHCelManager.getCurrentState` stale `targetDid` migration detection (latent, unreachable via public API).
- 18. `WebvhToBtcoMigration` satoshi fallback derives a txid, not a satoshi (fallback-only dead path).
- 19. Data Integrity `proofPurpose` not validated at verification time (spec conformance; needs a focused semantics change).
