# Phase 4: Ownership Is the Sat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ownership of an Originals asset = control of the anchoring satoshi, read live from Bitcoin. Ownership transfers become pure sat moves (a Bitcoin tx) that write NOTHING to the CEL; a buyer never inscribes to receive, own, or resell. The CEL is the authorship/provenance record only.

**Architecture:** This reverses the Phase-2 decision where `transferOwnership` appended a signed `transfer` CEL event. `transferOwnership` becomes a thin sat move. The `transfer` event type stops being written (parsers stay lenient toward legacy logs — dual-accept). `claimOwnership` is renamed `authorizeSigner` and reframed as OPTIONAL author-enablement (its mechanism is unchanged). Ownership is answered by a new `getCurrentOwner(asset)` over the Phase-0 `getSatOwnership`. `replayProvenance`/`ProvenanceChain` drop transfers entirely (ownership history lives on the sat's UTXO chain — omitted, not emulated). The verifier is entirely transfer-event-independent (confirmed by full read), so non-cooperative rotation + head-freshness survive untouched, re-documented as off the ownership path.

**Tech Stack:** TypeScript, Bun, Phases 0-3 machinery (all on this branch's stack).

## Global Constraints

- Tests from `packages/sdk/`; never import setup.bun.ts. `.js` relative imports. Plain Error in src/cel, StructuredError in src/lifecycle. Fail-closed; never weaken an existing verifier check.
- **The verifier does not change in this phase** except prose comments — the impact map §2 confirms zero transfer-event dependence. Any task that needs to touch `verifyEventLog.ts` logic (not comments) must STOP and report BLOCKED.
- **Dual-accept legacy:** parsers/verifier/layer-folds keep ACCEPTING `transfer` events (legacy logs verify unchanged); only WRITERS are removed. Must-not-regress verbatim: `tests/unit/cel/key-rotation-authority.test.ts`, `event-log-authorization.test.ts`, `verifyEventLog.test.ts`, `did-cel-verification.test.ts`, `non-cooperative-rotation.test.ts`, `json-serialization.test.ts`, `cbor-serialization.test.ts`, `tests/security/`.
- Commit per task, `--no-verify`, exact trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch `worktree-phase4-ownership-is-sat` (stacked on Phase 3 @ 946071a). Baseline: 3935 pass / 0 fail (packages/sdk); dist built.
- The FULL impact map (`.superpowers/sdd/impact-map.md`) carries every file:line anchor and strip/keep/reframe verdict — briefs reference it; consult it for exact locations.
- Locked decisions (binding): (a) `asset:transferred.from` = optional, best-effort pre-move `getSatOwnership`, NEVER fabricated; (b) `.transfers` = FULL REMOVAL, not always-empty (a lying API).

---

### Task 1: Thin `transferOwnership` — sat move, no CEL write

**Files (per impact map §1):**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (`transferOwnership` ~2039-2213; `appendCelEventOrSkip` union ~1743 + comment ~1756-1758)
- Modify: `packages/sdk/src/events/types.ts` (`AssetTransferredEvent` ~62-72 — drop `keyRotationPending?`)
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` (`recordTransfer` ~315-339 — reduce to emit-only, or delete and emit directly in transferOwnership; Task 2 removes the `.transfers` push regardless — coordinate: here just stop the CEL-append side, leave the provenance push for Task 2 to delete)
- Test: rewrite `tests/unit/lifecycle/LifecycleManager.transfer.unit.test.ts`; adjust `tests/unit/events/ManagerEventMirroring.test.ts` + `tests/integration/Events.test.ts` (keyRotationPending payload)

**Interfaces:**
- Produces (Tasks 4/5 depend on): `transferOwnership(asset, newOwner: string): Promise<BitcoinTransaction>` — SIGNATURE UNCHANGED, thin body: validate → did:btco guard + inFlight guard → resolve inscription → `bm.transferInscription` → emit `asset:transferred { asset, to, transactionId }` (both emitters; `from` optional best-effort pre-move `getSatOwnership`, never fabricated) → return `tx`. The asset's `celLog` is UNTOUCHED. No CEL_APPEND_FAILED_POST_TRANSFER, no logBefore/restore.

**Steps (TDD):** RED first — rewrite the transfer unit test to assert: after `transferOwnership`, `asset.celLog` is byte-identical (length + last-event type unchanged); the returned `tx.txid` is set; `asset:transferred` fires on both emitters WITHOUT `keyRotationPending`; a transfer on a keyStore-less asset succeeds identically (no degrade path anymore). Then strip per §1 → GREEN → full `bun test` (expect Task-2-owned `.transfers` failures — list them) → commit `feat(lifecycle): transferOwnership is a pure sat move; no CEL write (#366 ownership-is-sat)`.

---

### Task 2: Remove `.transfers` from provenance entirely

**Files (per impact map §5 — FULL REMOVAL):**
- Modify: `packages/sdk/src/lifecycle/replayProvenance.ts` (strip docstring :28-29, `ReplayedProvenance.transfers` :56, init :84, migrate-only loop :96, transfer arm :127-135)
- Modify: `packages/sdk/src/lifecycle/OriginalsAsset.ts` (`ProvenanceChain.transfers` :42-47; `recordTransfer` push :316-322 — now fully emit-only or gone; `getTransfersFrom` :358-360, `getTransfersTo` :365-367, `getProvenanceSummary` transferCount/lastActivity :381-390, `findByTransactionId` transfer branch :400-401)
- Modify: `packages/sdk/src/lifecycle/ProvenanceQuery.ts` (delete `Transfer` type :5, `.transfers()` :29+:198, transfer merge :85, `TransferQuery` class :206-250)
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (`buildRestoredProvenance` :640-709 — drop :682-687 transfer mapping; simplify :691-694 txid to btco-migration-only)
- Modify: `packages/sdk/src/examples/full-lifecycle-flow.ts` (:325-366 transfer-history usage)
- Modify: `packages/sdk/src/lifecycle/assetEnvelope.ts` (:5 comment)
- Test: prune `tests/unit/lifecycle/ProvenanceQuery.test.ts` (18 refs — delete TransferQuery cases), `replayProvenance.test.ts`, `loadAsset.test.ts` (7 refs), `tests/integration/CompleteLifecycle.e2e.test.ts` (15 refs), `LifecycleManager.transfer.comprehensive.test.ts`

**Interfaces:**
- Consumes: Task 1's thin transfer.
- Produces: `ProvenanceChain` and `ReplayedProvenance` have NO `transfers` field; no transfer query API. Restored and live provenance are parity-clean (both never have transfers).

**Steps (TDD):** RED (the Task-1 full-suite failures are largely these) → remove per §5, honest deletion (don't stub always-empty) → GREEN + must-not-regress → full `bun test` → commit `refactor(lifecycle): remove transfers from provenance (ownership history is the sat UTXO chain)`.

---

### Task 3: `claimOwnership` → `authorizeSigner` (rename + reframe)

**Files (per impact map §3 — mechanism UNCHANGED):**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (rename `claimOwnership` ~2519-2669 → `authorizeSigner`; reframe docstring + guard messages :2548/2557/2565; shared-core comments :2215/2238/2441/2449; `rotateBtcoKeys` doc :2389-2407 reframe "hand-off" → "optional authoring")
- Modify: exports in `src/index.ts` if `claimOwnership` is surfaced there
- Test: rename `tests/unit/lifecycle/LifecycleManager.claimOwnership.test.ts` → `.authorizeSigner.test.ts`, update call sites + wording (mechanism assertions KEEP); update `tests/integration/head-freshness-attack.e2e.test.ts` call sites (:9/32/40) — do NOT reshape CreatorBuyerHandoff here (Task 5)

**Interfaces:**
- Produces: `authorizeSigner(asset, newVerificationMethod: { publicKeyMultibase, privateKey }, feeRate?): Promise<{ inscriptionId, did }>` — identical behavior to the old `claimOwnership`, reframed as optional author-enablement. No deprecated alias (all callers in-repo, pre-1.0).

**Steps (TDD):** rename-driven — run the renamed suite RED (symbol not found) → rename + reframe → GREEN + full `bun test` → commit `refactor(lifecycle): rename claimOwnership → authorizeSigner (optional author-enablement, not ownership)`.

---

### Task 4: `getCurrentOwner` + off-the-CEL re-documentation

**Files (per impact map §4):**
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (new `getCurrentOwner(asset)` near `verifyAsset`)
- Modify: `packages/sdk/src/cel/algorithms/verifyEventLog.ts` (PROSE ONLY — reword "pre-transfer" at :470 and any head-freshness/non-coop comments to "off the ownership path / optional authoring"; NO logic change — if a logic change seems needed, BLOCKED)
- Modify: `packages/sdk/src/lifecycle/LifecycleManager.ts` (loadAsset warning prose :530-534)
- Test: `tests/unit/lifecycle/getCurrentOwner.test.ts` (new)

**Interfaces:**
- Consumes: `getSatOwnership` (adapters/types.ts:68-74), `parseSatoshiIdentifier` (already imported).
- Produces: `getCurrentOwner(asset): Promise<{ address: string; outpoint: string } | null>` — btcoDid from `bindings['did:btco'] ?? (asset.id.startsWith('did:btco:') ? asset.id : undefined)`; null if absent; `parseSatoshiIdentifier` → `getSatOwnership`; throws `ORD_PROVIDER_REQUIRED` when no `config.ordinalsProvider`; null when provider lacks `getSatOwnership` or lookup returns null (mirror the resolver fail-open). Return type identical to `getSatOwnership`.

**Steps (TDD):** RED (create→publish→inscribe with OrdMock → `getCurrentOwner` = the mock owner; after `transferInscription` to a new address → `getCurrentOwner` = new address; a non-btco asset → null; no-provider SDK → throws ORD_PROVIDER_REQUIRED) → implement → GREEN + full `bun test` → commit `feat(lifecycle): getCurrentOwner reads ownership from the sat; re-document CEL as authorship-only`.

---

### Task 5: Delete the transfer CLI + reshape the e2es

**Files (per impact map §2, §7):**
- Delete: `packages/sdk/src/cel/cli/transfer.ts` + its registration in the CLI index (grep the cli entry/index for the `transfer` command wiring) + `tests/unit/cel/cli-transfer.test.ts`
- Modify: `tests/integration/CelConvergence.e2e.test.ts` — expected event sequence drops `'transfer'` (~:85); the transfer step (~:71-72) becomes a sat move that provably does NOT grow the log (assert `celLog.events.length` unchanged across it)
- Modify: `tests/integration/CreatorBuyerHandoff.e2e.test.ts` — RESHAPE per §7: A create→publish→inscribe→serialize (unchanged) → B loadAsset+verify keyless (unchanged) → the degrade probe (~:169-172) can't use `transferOwnership` (no append) — replace with an `update`/resource authoring attempt that degrades, or drop → A `transferOwnership` = sat move; ADD `getCurrentOwner(asset) === BUYER_ADDR` (the model's headline) → B `authorizeSigner` (optional) → third-party verify + STALE_LOG guard unchanged → "B's appends now succeed" uses an authoring `update` event (assert log GROWTH) → B's onward resale = a sat move with NO log growth + `getCurrentOwner` flips to the next buyer (the sharpest new-model assertion)
- Modify: `tests/integration/Lifecycle.transfer.btco.integration.test.ts` (small rewrite)

**Interfaces:** consumes Tasks 1-4. Produces no new interfaces — this is the model's proof surface.

**Steps:** delete the CLI (verify the command index no longer references it; `bun test tests/unit/cel/` green) → reshape both e2es → run them (failures = integration bugs, fix here; design-implicating → BLOCKED) → full `bun test` → commit `test: delete transfer CLI; reshape e2es to ownership-is-sat (sat move grows no log)`.

---

### Task 6: Docs sweep

**Files (per impact map §8):**
- Modify: `docs/superpowers/specs/2026-07-10-cel-backbone-did-cel-design.md` (§5/§6: transfer = pure sat move no CEL write; rotation-first rescoped to optional author-enablement; add a Phase-4 decision entry to §0)
- Modify: `docs/ORIGINALS_CEL_SPEC.md` (mark `transfer` event LEGACY/read-only: verifiers MUST accept, writers MUST NOT emit; 1.2.0 changelog row)
- Modify: `specs/did-cel-method.md` (transfer row → legacy-read; conformance row 18 stays as dual-accept)
- Modify: `CLAUDE.md` (:150-151: transferOwnership = sat move only; authorizeSigner = optional authoring)
- Modify: `docs/LLM_AGENT_GUIDE.md` + `docs/LLM_QUICK_REFERENCE.md` (hand-off flow rewrite: receive = sat move, no inscription; authoring = optional authorizeSigner)
- Verify-only (confirm no stale claims): `originals-whitepaper.md` (already states the model), `docs/BITCOIN_INTEGRATION_GUIDE.md`
- Cross-check: every normative "transfer writes a CEL event" / "claimOwnership is ownership" statement is gone; the new model (ownership = sat, CEL = authorship) is stated once, clearly, in each authoritative doc.

**Steps:** edit per §8 → grep for residual `claimOwnership` / "transfer event" / "keyRotationPending" in docs → `bun test` (docs-only, stays green) → commit `docs: ownership is the sat; transfer event legacy-read; authorizeSigner reframe`.

---

### Task 7: Full-suite verification + final review

- [ ] `bun test` zero non-flaky failures; `bunx tsc --noEmit` clean; changed-files eslint zero errors; `bun run build` clean.
- [ ] Confirm the dual-accept invariant by test: a hand-built legacy log containing a signed `transfer` event still `verifyEventLog`-verifies (add if not already covered).
- [ ] Final whole-branch review (fable) over `946071a..HEAD` — focus: did any transfer-removal silently weaken the verifier or drop a legitimate provenance path; is `getCurrentOwner` the sole ownership answer with no CEL conflation left; is the dual-accept boundary clean. Fix Critical/Important; re-verify.
