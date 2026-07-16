# Phase 3: Interchange & Hand-off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator can hand an asset to a buyer who loads and verifies it offline (#377); did:cel resolves from storage; a non-cooperative new owner can claim authorship via reinscription; the log's hosted/anchored copies stay fresh and truncation is detectable.

**Architecture:** The envelope's provenance section IS the CEL — `bindings`/`currentLayer`/migrations are deliberately NOT first-class fields (they're folds via `replayProvenance`); log-underivable operational metadata rides in an explicit `unverified` honesty section. `loadAsset` verifies by default and rebuilds via an `@internal static restore()` factory (no fabricated clocks, no replayed events). Non-cooperative rotation: a rotateKey NOT signed by the current authority is accepted iff witnessed by a reinscription on the asset's own anchored sat announcing the same key that signed the event — four fail-closed checks, no new event types. `checkHeadFreshness` closes the truncated-log attack with a provider.

**Tech Stack:** TypeScript, Bun, Phases 0–2 machinery (all merged on this branch).

## Global Constraints

- Tests from `packages/sdk/`; never import setup.bun.ts. `.js` relative imports. Plain Error in src/cel, StructuredError in src/lifecycle. Fail-closed always; never weaken an existing check.
- Must-not-regress verbatim: `tests/unit/cel/event-log-authorization.test.ts`, `key-rotation-authority.test.ts`, `verifyEventLog.test.ts`, `did-cel-verification.test.ts`, `hash-chain-tamper.test.ts`, `tests/security/`. The non-cooperative arm is additive (gated on witness proofs today's failing logs don't carry) — all current rejections survive.
- Commit per task, `--no-verify`, exact trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch `worktree-phase3-interchange` (stacked on Phase 2 @ 5b01917). Baseline: 3841 pass / 0 fail (packages/sdk); cel-cli-coverage subprocess tests flaky under load — judge in isolation; dist/ built.
- Anchors verified on this branch; locate by quoted code if drifted. The integration map (in the ledger dir as `integration-map.md`) carries the full analysis — briefs reference it.
- Honest-gap rule (binding): `addResourceVersion` writes no CEL event until Phase 4; post-genesis versions ride in `resources` + `unverified.resourceUpdates`, accepted because the genesis-binding check is subset-direction. Never promote `unverified.*` into trusted state.

---

### Task 1: `AssetEnvelope` + `serialize()` + DID-document capture

**Files:**
- Create: `packages/sdk/src/lifecycle/assetEnvelope.ts` (the interface, exactly per the integration map §1: `ASSET_ENVELOPE_FORMAT = 'originals/asset'`, `ASSET_ENVELOPE_VERSION = 1`, `AssetEnvelope { format, version, assetDid, eventLog, didDocuments: { 'did:cel', 'did:webvh'?, 'did:btco'? }, resources, credentials?, unverified?: { commitTxId?, feeRate?, resourceUpdates?, bindings? } }`)
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` — private `#didDocuments` map + `@internal _captureDidDocument(layer, doc)` + `serialize(): AssetEnvelope` (sync, pure; throws `StructuredError('ASSET_NOT_SERIALIZABLE')` when no `#celLog`)
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` — capture calls: `publishToWeb` (~612, `migration.didDocument` in hand), `inscribeOnBitcoin` (the btco doc built in `buildContent` ~1424-1443 — hoist/capture it), `rotateBtcoKeys` (~1794, replaces the btco entry)
- Modify: `packages/sdk/src/index.ts` (export envelope types)
- Test: `packages/sdk/tests/unit/lifecycle/assetEnvelope.test.ts`

**Interfaces:**
- Produces (Tasks 2, 8 depend on): the exact `AssetEnvelope` interface; `asset.serialize()`; captured docs present after publish/inscribe/rotate. `eventLog` embedded as the parsed object; `unverified.bindings` = live-cache snapshot ONLY when the fold can't derive btco (check via `replayProvenance`); `unverified.commitTxId`/`feeRate`/`resourceUpdates` from the provenance cache.

**Steps (TDD):** failing test (serialize after full lifecycle → envelope carries log + all three docs + resources w/ content + honesty section; serialize on a legacy 3-arg asset throws; round-trip `JSON.parse(JSON.stringify(env))` deep-equals) → RED → implement → GREEN (`tests/unit/lifecycle/`) + full `bun test` → commit `feat(lifecycle): AssetEnvelope + serialize() with per-layer DID-document capture (#377)`.

---

### Task 2: `loadAsset` + `OriginalsAsset.restore()` + genesis-binding extraction

**Files:**
- Create: `packages/sdk/src/lifecycle/genesisBinding.ts` — extract the resource↔genesis subset check from `OriginalsAsset.runVerificationChecks` (~334-356) as pure `checkGenesisResourceBinding(log, resources): boolean`; `runVerificationChecks` delegates (behavior byte-identical)
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` — `@internal static restore(resources, did, credentials, log, restored: { currentLayer, bindings, provenance })` — constructs then overwrites `currentLayer`/`bindings`/`#provenance`; NO events emitted, NO clock reads
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` — `loadAsset(envelope | string, opts?: { skipVerification?, ordinalsProvider? }): Promise<{ asset, verification?, warnings }>` per the integration map §2's seven steps: format/version validation (reject majors > supported, `ENVELOPE_VERSION_UNSUPPORTED`); log through `parseEventLogJson` (via JSON round-trip or a `parseEventLogObject` helper beside it); `verifyEventLog` w/ `expectedDid` + `resolveKey` + provider (default `config.ordinalsProvider`) → throw `ASSET_LOAD_VERIFICATION_FAILED` carrying the result; `checkGenesisResourceBinding` + per-resource inline-content hash check (mirror `assertContentMatchesDeclaredHash` ~908-919); `replayProvenance` fold + cross-checks (`didCelMatchesLog`; envelope docs' ids === folded bindings, mismatch fails); provenance assembly (createdAt/creator from genesis data, migrations/transfers from the fold, `unverified.*` passed through as advisory); degraded-binding rule — `unverified.bindings` NEVER promoted, surfaced in `warnings`
- Test: `packages/sdk/tests/unit/lifecycle/loadAsset.test.ts`

**Interfaces:**
- Consumes: Task 1's envelope; `replayProvenance`, `didCelMatchesLog`, `parseEventLogJson`, `createDidManagerKeyResolver`.
- Produces (Task 8 depends on): the `loadAsset` API above; `OriginalsAsset.restore`; shared `checkGenesisResourceBinding`.

**Steps (TDD):** failing tests (round-trip: serialize → loadAsset in the SAME manager → verification.verified true, provenance parity with the live cache, currentLayer/bindings restored, no `asset:migrated` events fired during load; tampered event → `ASSET_LOAD_VERIFICATION_FAILED`; version 2 envelope → `ENVELOPE_VERSION_UNSUPPORTED`; swapped did:webvh doc in envelope → fails; missing genesis resource → fails; `skipVerification: true` → asset returned, verification absent) → RED → implement → GREEN + full suite → commit `feat(lifecycle): loadAsset with verify-on-load + restore factory (#377)`.

---

### Task 3: Persistence — `cel/<digest>.json` at appends, cel.json refresh, did:cel resolution

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` — from the `appendCelEventOrSkip` choke point (~1319-1344) after a successful append: (a) best-effort write `cel/${didCelSuffix}.json` via the storage adapter (both duck-typed shapes, mirror `hostCelLog`); (b) when `asset.bindings?.['did:webvh']` exists, re-host cel.json (`hostCelLog`) so the hosted copy stays fresh; emit a `cel:host-failed` warn event on error (register in events/types.ts + EventLogger.ts) — NEVER gate the lifecycle op. Also write `cel/<suffix>.json` at `createAsset` (post-~300). publishToWeb's inline degrade block is Task 4's dedup — coordinate: this task touches the helper only.
- Modify: `packages/sdk/src/cel/celDid.ts` — generalize `resolveDidCel(did, log, opts?: Pick<VerifyOptions, 'resolveKey' | 'ordinalsProvider'>)`
- Modify: `packages/sdk/src/did/DIDManager.ts` — fill the honest-null did:cel branch (~535-545): storage lookup at the conventional key → `parseEventLogJson` → `resolveDidCel` threading `config.ordinalsProvider` via the existing adapter seam (~495) → cache via `this.cache.set` (~565-567); no storage/miss → warn + null as today
- Test: extend `tests/unit/did/` + `tests/unit/lifecycle/` (resolution round-trip: createAsset → `sdk.did.resolveDID(asset.id)` returns the facade doc from storage; post-rotation resolution reflects the NEW controller; adapter-less SDK unchanged)

**Steps (TDD):** RED → implement → GREEN + full suite → commit `feat(did,lifecycle): persistence-backed did:cel resolution; hosted CEL stays fresh`.

---

### Task 4: Small carry-forwards — publish dedup, rotate inFlight guard, `verifyAsset`

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts`: (a) replace publishToWeb's inline degrade block (~649-686) with `appendCelEventOrSkip` (rollback + `celAppended` gating keep working off the helper's return); (b) `rotateBtcoKeys` gains the `inFlightAssets` claim + finally-delete exactly as transferOwnership (~1618-1624); (c) new `verifyAsset(asset, overrides?)` calling `asset.verify({ didManager, credentialManager, ordinalsProvider: overrides?.ordinalsProvider ?? this.config.ordinalsProvider })` — the SDK's `OrdinalsProvider` is structurally an `OrdinalsLookup`; do NOT inject config into OriginalsAsset
- Test: concurrency test beside `LifecycleManager.transfer.concurrency.test.ts` (two concurrent rotates → one `OPERATION_IN_PROGRESS`); `verifyAsset` happy path without hand-passing a provider; publish regression net = existing WebVhPublish/mintwebvh suites

**Steps (TDD where new behavior):** RED → implement → GREEN + full suite → commit `refactor(lifecycle): dedup publish degrade contract; rotate inFlight guard; verifyAsset provider threading`.

---

### Task 5: Non-cooperative rotation — verifier acceptance rule (fable)

**Files:**
- Modify: `packages/sdk/src/cel/algorithms/verifyEventLog.ts` — per the integration map §4, exactly:
  - New walk state `anchoredSat: { satoshi, inscriptionId } | undefined`, set when a migrate event's gating bitcoin witness proof verifies.
  - A rotateKey whose controller proof is NOT authorized by the current set is accepted IFF ALL of: **(a)** it carries a `bitcoin-ordinals-2024` witness proof with `proof.satoshi === anchoredSat.satoshi` and `verifyBitcoinWitnessProof` passes in full against THIS event's chain digest (no `anchoredSat` → fail as today); **(b)** the inscribed DID doc's `verificationMethod[].publicKeyMultibase` includes an Ed25519 key ∈ `selfCertifyingKeyHexes(data.newController)` (self-certifying targets only; resolver-backed fail closed); **(c)** the event's controller-proof key is itself ∈ `selfCertifyingKeyHexes(newController)` — signer ≡ announced key ≡ inscribed key; **(d)** via `getInscriptionsBySatoshi`, the rotation's inscriptionId appears at a STRICTLY LATER index than `anchoredSat.inscriptionId` (missing lookup → fail closed).
  - On acceptance: swap `authorizedKeyIds` exactly as the cooperative arm; update `anchoredSat.inscriptionId` to the rotation's inscription.
  - Every check unverifiable → fail. NO ordering-vs-transfer-tx check (the sat itself enforces control at reinscription time — document that reasoning in a comment; do NOT extend OrdinalsLookup).
- Test: `packages/sdk/tests/unit/cel/non-cooperative-rotation.test.ts` — happy path (build the witnessed reinscription via OrdMock `targetSatoshi` + hand-attach the witness proof exactly as inscribeOnBitcoin does); adversarial: foreign-sat witness (fails a); inscribed doc announces key X, event signed by Y (fails c); newController ≠ inscribed key (fails b); rotation inscription at an EARLIER index (fails d); no provider (fails closed); post-acceptance: old key dead, new key authorizes, a SECOND non-cooperative rotation chains off the updated anchoredSat.

**Steps (TDD, all adversarial cases RED-first):** → implement → GREEN + must-not-regress suites verbatim + full suite → commit `feat(cel): non-cooperative rotation — reinscription-attested authority hand-off (#366)`.

---

### Task 6: `claimOwnership` + controller-signed witness acknowledgment

**Files:**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts`:
  - Extract a shared private core from `rotateBtcoKeys` (doc building w/ backLinks + manifest + `#cel` anchor, `targetSatoshi` reinscription, pre-append-restore rollback, keyStore registration incl. the derive-check).
  - New `claimOwnership(asset, { publicKeyMultibase, privateKey /* REQUIRED */ }, feeRate?)`: guards (layer, binding, inFlight); append the rotateKey **self-signed with the NEW key** (`celSignerFromKeyPair`-style — explicitly NOT `appendCelEventOrSkip`); embed `#cel` = the rotateKey digest; reinscribe; attach the bitcoin witness proof to the rotateKey event post-inscription (mirror inscribeOnBitcoin ~1480-1502); register the key.
  - Witness acknowledgment: after the witness-proof attach in `inscribeOnBitcoin`, `rotateBtcoKeys`, AND `claimOwnership`, append a controller-signed `update` event `{ operation: 'acknowledgeWitness', satoshi, inscriptionId, txid?, witnessedEventDigest }` via the standard append path (degrade rules apply; non-gating for the verifier; `replayProvenance` already ignores updates). For claimOwnership the acknowledging controller is the NEW key (it's current post-rotation).
- Test: extend rotate tests + new claim tests — after transferOwnership to a new party, `claimOwnership` with a fresh key → `verifyEventLog` accepts the whole log (exercises Task 5's rule through the REAL write path); old controller's subsequent append attempts fail verification; acknowledgment events present and signed by the right controller at each site.

**Steps (TDD):** RED → implement → GREEN + full suite → commit `feat(lifecycle): claimOwnership via reinscription; controller-signed witness acknowledgment`.

---

### Task 7: `checkHeadFreshness` — truncated-log detection

**Files:**
- Modify: `packages/sdk/src/cel/algorithms/verifyEventLog.ts` + `types.ts` — `VerifyOptions.checkHeadFreshness?: boolean` (default FALSE): when set and `anchoredSat` exists, enumerate `getInscriptionsBySatoshi`, find the NEWEST inscription whose content is a DID doc carrying an `OriginalsCelAnchor`, require its `headDigestMultibase` to equal the chain digest of some event PRESENT in the presented log; else fail with a `STALE_LOG`-coded error in `errors`.
- Modify: `OriginalsAsset.verify` + `LifecycleManager.loadAsset`/`verifyAsset` — set `checkHeadFreshness: true` whenever a provider is available; offline (`skipVerification` false but no provider on a non-anchored log) → note in `loadAsset.warnings`.
- Test: seller-hands-buyer-a-pre-rotation-log attack — full lifecycle incl. rotation, serialize a TRUNCATED log (slice events before the rotation, re-serialize), loadAsset with the shared OrdMock → fails STALE_LOG; the honest full log passes; no-provider load carries the warning.

**Steps (TDD):** RED → implement → GREEN + must-not-regress + full suite → commit `feat(cel): head-freshness check closes truncated-log hand-off attack`.

---

### Task 8: Creator→buyer e2e + docs

**Files:**
- Create: `packages/sdk/tests/integration/CreatorBuyerHandoff.e2e.test.ts` — per the integration map §6: SDK A (keyStore, storage, OrdMock) create→publish→inscribe→serialize; **SDK B fresh** (fresh MockKeyStore, fresh storage, SAME OrdMock instance) loadAsset → verified, fold parity, resolve historical DIDs (did:cel via the persistence branch on A's storage — B gets A's storage adapter for resolution OR the envelope suffices, decide per what's honest); assert the keyStore contract: B's appends degrade (`cel:append-skipped`/NO_SIGNING_KEY) → A transfers to B's address → B `claimOwnership` with B's own key → third fresh verifier verifies the whole log incl. the non-cooperative rotation → B's appends now succeed.
- Modify: `CLAUDE.md` (serialize/loadAsset + claimOwnership in the architecture notes, surgical), `docs/LLM_AGENT_GUIDE.md` + `docs/LLM_QUICK_REFERENCE.md` (the hand-off flow), design spec §7 (Phase 3 delivered; remaining → Phase 4: VC derivation, inline-content inscription, resource-update events, layer-label rename, did:peer deprecations).
- Record the honest gap in the docs: resource versions are envelope-carried/unverifiable until Phase 4 puts updates on-log.

**Steps:** write e2e → run (failures = integration bugs, fix here; design-implicating → BLOCKED) → docs → full suite → commit `test+docs: creator→buyer hand-off e2e; interchange docs`.

---

### Task 9: Full-suite verification + final review

- [ ] `bun test` zero non-flaky failures; `bunx tsc --noEmit` clean; changed-files eslint zero errors; `bun run build` clean.
- [ ] Final whole-branch review (fable) over `5b01917..HEAD` with the accumulated Minor roll-up; fix Critical/Important; re-verify.
